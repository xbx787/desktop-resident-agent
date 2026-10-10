/** Locating and launching the Claude Code CLI: where it hides on a Windows
 *  install and what environment the child process needs. (The old direct
 *  stream-json client died when the SDK path took over — SDK sessions live in
 *  claude-agent.ts.) */
import { existsSync } from 'node:fs'
import path from 'node:path'

export const CLAUDE_BASE_URL = 'https://api.deepseek.com/anthropic'
export const DEFAULT_CLAUDE_MODEL = 'deepseek-flash[1m]'

/** Directories a shortcut-launched GUI process tends to miss: version and
 *  package managers keep CLIs (and the git bash that Claude Code spawns) in
 *  per-user locations that never make it into a desktop shortcut's PATH. */
export function extraBinaryPaths(env: NodeJS.ProcessEnv): string[] {
  const home = env.USERPROFILE ?? env.HOME
  const localAppData = env.LOCALAPPDATA
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
  const programFilesX86 = env['ProgramFiles(x86)'] ?? env['PROGRAMFILES(X86)']
  return [
    env.APPDATA && path.join(env.APPDATA, 'npm'),
    home && path.join(home, '.local', 'bin'),
    home && path.join(home, '.volta', 'bin'),
    home && path.join(home, '.bun', 'bin'),
    home && path.join(home, 'scoop', 'shims'),
    localAppData && path.join(localAppData, 'pnpm'),
    localAppData && path.join(localAppData, 'Programs', 'claude'),
    programFiles && path.join(programFiles, 'nodejs'),
    programFiles && path.join(programFiles, 'Git', 'cmd'),
    programFiles && path.join(programFiles, 'Git', 'bin'),
    programFilesX86 && path.join(programFilesX86, 'Git', 'cmd'),
    env.ProgramData && path.join(env.ProgramData, 'chocolatey', 'bin')
  ].filter((item): item is string => Boolean(item))
}

/** The process PATH with {@link extraBinaryPaths} appended, deduplicated
 *  case-insensitively (Windows). Existing entries keep their order. */
export function enhancedPath(env: NodeJS.ProcessEnv): string {
  const parts = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean)
  const seen = new Set(parts.map((part) => part.toLowerCase()))
  for (const directory of extraBinaryPaths(env)) {
    const key = directory.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    parts.push(directory)
  }
  return parts.join(path.delimiter)
}

/** The Claude engine bundled with the agent SDK inside the app itself: a
 *  packaged build keeps it unpacked under resources (reading it through the
 *  asar path redirects there too), a dev run reads it straight from
 *  node_modules. */
export function bundledClaudeExecutable(): string | undefined {
  const relative = path.join('node_modules', '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, 'claude.exe')
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', relative) : undefined,
    path.join(__dirname, '..', '..', relative)
  ]
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

export function findClaudeExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.USERPROFILE ?? env.HOME
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES
  const candidates = [
    env.DESKTOP_PET_CLAUDE_EXE,
    // The engine that ships inside the app wins over system installs: the app
    // then runs the exact engine its build shipped with, on any machine, with
    // nothing preinstalled.
    bundledClaudeExecutable(),
    env.APPDATA && path.join(env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    home && path.join(home, '.local', 'bin', 'claude.exe'),
    programFiles && path.join(programFiles, 'nodejs', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
    ...extraBinaryPaths(env).map((directory) => path.join(directory, 'claude.exe'))
  ]
  // `.cmd` shims are skipped on purpose: spawning them needs a shell, and
  // stopping them takes a different path (taskkill /t) — a native `.exe`
  // avoids the whole class of problems.
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)))
}

export interface ClaudeEnvironmentOptions {
  apiKey: string
  /** Endpoint for the CLI; defaults to DeepSeek's Anthropic-compatible API. */
  baseUrl?: string
  /** Main model id; defaults to the launch-time DeepSeek model. */
  model?: string
  /** Small/fast model for the Haiku slot and subagents. */
  smallModel?: string
  configDir?: string
  /** Extra KEY=VALUE lines from the profile's advanced field, applied last. */
  extraEnv?: string
}

/** Builds the CLI child environment for one provider configuration. */
export function claudeEnvironment(env: NodeJS.ProcessEnv, options: ClaudeEnvironmentOptions): NodeJS.ProcessEnv {
  const { apiKey, baseUrl = CLAUDE_BASE_URL, model = DEFAULT_CLAUDE_MODEL, smallModel = 'deepseek-flash', configDir, extraEnv } = options
  const childEnv = { ...env }
  for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY']) delete childEnv[name]
  delete childEnv.DEEPSEEK_API_KEY
  delete childEnv.DISABLE_AUTO_COMPACT
  delete childEnv.DISABLE_COMPACT
  childEnv.ANTHROPIC_BASE_URL = baseUrl
  childEnv.ANTHROPIC_AUTH_TOKEN = apiKey
  childEnv.ANTHROPIC_MODEL = model
  childEnv.ANTHROPIC_DEFAULT_OPUS_MODEL = model
  childEnv.ANTHROPIC_DEFAULT_SONNET_MODEL = model
  childEnv.ANTHROPIC_DEFAULT_HAIKU_MODEL = smallModel
  childEnv.CLAUDE_CODE_SUBAGENT_MODEL = smallModel
  childEnv.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
  childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = '70'
  // The documented marker for host applications: settings files must not
  // override the endpoint/key/model this host injects.
  childEnv.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
  // A shortcut-launched GUI process has a minimal PATH; the CLI (and the bash
  // it spawns for tools) needs the usual install locations appended.
  for (const key of Object.keys(childEnv)) {
    if (key.toLowerCase() === 'path') delete childEnv[key]
  }
  childEnv.PATH = enhancedPath(env)
  if (configDir) childEnv.CLAUDE_CONFIG_DIR = configDir
  if (extraEnv?.trim()) applyEnvText(childEnv, extraEnv)
  return childEnv
}

/** Parses KEY=VALUE lines (the profile form's advanced field); skips blanks,
 *  comments and malformed lines instead of failing. */
export function applyEnvText(env: NodeJS.ProcessEnv, text: string): void {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = trimmed.slice(eq + 1).trim()
  }
}

/** One tiny messages request against an Anthropic-compatible endpoint — the
 *  model form's "test the connection" button. Never throws. */
export async function probeAnthropicEndpoint(profile: { baseUrl: string; apiKey: string; model: string }): Promise<{ ok: boolean; message: string }> {
  const endpoint = `${profile.baseUrl.replace(/\/+$/, '')}/v1/messages`
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': profile.apiKey,
        'authorization': `Bearer ${profile.apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: profile.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
      signal: AbortSignal.timeout(15_000)
    })
    if (response.ok) return { ok: true, message: '连接成功，模型可用。' }
    const raw = await response.text().catch(() => '')
    const detail = (() => {
      try {
        const parsed = JSON.parse(raw) as { error?: { message?: string } }
        return parsed?.error?.message?.slice(0, 160) ?? (raw ? raw.slice(0, 160) : '无返回内容')
      } catch { return raw ? raw.slice(0, 160) : '无返回内容' }
    })()
    if (response.status === 401 || response.status === 403) return { ok: false, message: `鉴权失败（${response.status}）：API Key 可能不正确。` }
    if (response.status === 404) return { ok: false, message: `端点或模型不存在（404）：${detail}` }
    return { ok: false, message: `请求失败（${response.status}）：${detail}` }
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') return { ok: false, message: '连接超时（15 秒）。' }
    return { ok: false, message: `无法连接到 ${profile.baseUrl}。` }
  }
}
