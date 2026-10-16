import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ClaudeWorkflowOption } from '../shared/contracts'

/** Metadata only. The Agent SDK owns loading and executing the actual workflow files. */
export interface ClaudeWorkflow {
  name: string
  description: string
  kind: 'command' | 'skill'
  source: 'user' | 'project'
  path: string
}

export interface ClaudeWorkflowRoots {
  projectRoot: string
  /** Must match the SDK's CLAUDE_CONFIG_DIR when that override is in use. */
  userConfigRoot?: string
}

export interface ResolvedWorkflowPrompt {
  prompt: string
  workflow: ClaudeWorkflow
}

const MAX_HEADER_BYTES = 8192
const MAX_COMMAND_DEPTH = 8
const MAX_ENTRIES_PER_DIRECTORY = 512
const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/

/** Commands implemented by the app itself; SDK commands are appended at runtime. */
export const APP_SLASH_COMMANDS: readonly ClaudeWorkflowOption[] = [
  { name: 'new', description: '新建对话，保留原对话', kind: 'command', source: 'builtin' },
  { name: 'side', description: '展开临时侧聊，不写入主会话', kind: 'command', source: 'builtin' },
  { name: 'btw', description: '展开临时侧聊', kind: 'command', source: 'builtin' },
  { name: 'sessions', description: '打开会话库', kind: 'command', source: 'builtin' },
  { name: 'model', description: '打开模型与上下文面板', kind: 'command', source: 'builtin' },
  { name: 'help', description: '查看可用命令', kind: 'command', source: 'builtin' },
  { name: 'compact', description: '压缩当前对话上下文', kind: 'command', source: 'builtin' }
]

export type AppSlashCommandName = 'new' | 'side' | 'btw' | 'sessions' | 'model' | 'help' | 'compact'

export function parseAppSlashCommand(input: string): { name: AppSlashCommandName; args: string } | null {
  if (typeof input !== 'string') return null
  const match = /^\/([a-z][a-z0-9_-]*)(?:\s+([\s\S]*))?$/i.exec(input.trim())
  if (!match) return null
  const name = match[1].toLowerCase()
  if (!APP_SLASH_COMMANDS.some((command) => command.name === name)) return null
  return { name: name as AppSlashCommandName, args: (match[2] ?? '').trim() }
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function safeEntries(directory: string): Promise<import('node:fs').Dirent[]> {
  try {
    return (await fs.readdir(directory, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, MAX_ENTRIES_PER_DIRECTORY)
  } catch {
    return []
  }
}

function scalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length < 2) return trimmed
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try { return JSON.parse(trimmed) as string } catch { return trimmed.slice(1, -1) }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function parseFrontmatter(prefix: string): Record<string, string> {
  const lines = prefix.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return {}
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === '---')
  if (closing < 0) return {}
  const fields: Record<string, string> = {}
  for (let index = 1; index < closing; index += 1) {
    const match = /^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(lines[index])
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2]
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts: string[] = []
      while (index + 1 < closing && /^\s+\S/.test(lines[index + 1])) {
        parts.push(lines[++index].trim())
      }
      fields[key] = parts.join(value.startsWith('>') ? ' ' : '\n')
    } else {
      fields[key] = scalar(value)
    }
  }
  return fields
}

async function metadata(filePath: string, root: string): Promise<Record<string, string> | null> {
  try {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) return null
    const realRoot = await fs.realpath(root)
    const realFile = await fs.realpath(filePath)
    if (!inside(realRoot, realFile)) return null
    const file = await fs.open(filePath, 'r')
    try {
      const bytes = Buffer.alloc(Math.min(stat.size, MAX_HEADER_BYTES))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      return parseFrontmatter(bytes.toString('utf8', 0, bytesRead))
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function commands(root: string, source: ClaudeWorkflow['source']): Promise<ClaudeWorkflow[]> {
  const base = path.join(root, 'commands')
  const found: ClaudeWorkflow[] = []
  async function walk(directory: string, segments: string[]): Promise<void> {
    if (segments.length > MAX_COMMAND_DEPTH) return
    for (const entry of await safeEntries(directory)) {
      if (entry.isSymbolicLink()) continue
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory() && VALID_NAME.test(entry.name)) {
        await walk(entryPath, [...segments, entry.name])
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        const leaf = entry.name.replace(/\.md$/i, '')
        if (!VALID_NAME.test(leaf)) continue
        const frontmatter = await metadata(entryPath, root)
        if (!frontmatter || frontmatter['user-invocable']?.toLowerCase() === 'false') continue
        found.push({
          name: [...segments, leaf].join(':'),
          description: frontmatter.description ?? frontmatter.when_to_use ?? '',
          kind: 'command', source, path: entryPath
        })
      }
    }
  }
  await walk(base, [])
  return found
}

async function skills(root: string, source: ClaudeWorkflow['source']): Promise<ClaudeWorkflow[]> {
  const base = path.join(root, 'skills')
  const found: ClaudeWorkflow[] = []
  for (const entry of await safeEntries(base)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !VALID_NAME.test(entry.name)) continue
    const directory = path.join(base, entry.name)
    const manifest = (await safeEntries(directory)).find((file) => file.isFile() && file.name.toLowerCase() === 'skill.md')
    if (!manifest) continue
    const filePath = path.join(directory, manifest.name)
    const frontmatter = await metadata(filePath, root)
    if (!frontmatter || frontmatter['user-invocable']?.toLowerCase() === 'false') continue
    const name = frontmatter.name || entry.name
    if (!VALID_NAME.test(name)) continue
    found.push({
      name,
      description: frontmatter.description ?? frontmatter.when_to_use ?? '',
      kind: 'skill', source, path: filePath
    })
  }
  return found
}

function priority(workflow: ClaudeWorkflow): number {
  // Claude Code gives skills priority over legacy command files, then user over project.
  return (workflow.kind === 'skill' ? 2 : 0) + (workflow.source === 'user' ? 1 : 0)
}

/**
 * Discover local user/project metadata for the picker. Prefer the SDK's
 * system/init slash_commands list as the authoritative live availability check.
 * https://code.claude.com/docs/en/agent-sdk/slash-commands
 * https://github.com/YishenTu/claudian/blob/main/src/providers/claude/commands/ClaudeCommandCatalog.ts
 */
export async function listClaudeWorkflows(roots: ClaudeWorkflowRoots): Promise<ClaudeWorkflow[]> {
  const project = path.resolve(roots.projectRoot, '.claude')
  const user = path.resolve(roots.userConfigRoot ?? path.join(os.homedir(), '.claude'))
  const discovered = (await Promise.all([
    commands(user, 'user'), skills(user, 'user'),
    commands(project, 'project'), skills(project, 'project')
  ])).flat()
  const effective = new Map<string, ClaudeWorkflow>()
  for (const candidate of discovered) {
    const key = candidate.name.toLowerCase()
    const current = effective.get(key)
    if (!current || priority(candidate) > priority(current)) effective.set(key, candidate)
  }
  return [...effective.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Convert a picker invocation to an SDK-native command without reading its body. */
export function resolveClaudeWorkflowPrompt(
  input: string,
  available: readonly ClaudeWorkflow[]
): ResolvedWorkflowPrompt | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trimStart()
  const match = /^[/\$]([a-zA-Z0-9][a-zA-Z0-9_:-]*)(?=\s|$)([\s\S]*)$/.exec(trimmed)
  if (!match) return null
  const workflow = available.find((item) => item.name.toLowerCase() === match[1].toLowerCase())
  if (!workflow) return null
  return { prompt: `/${workflow.name}${match[2]}`, workflow }
}
