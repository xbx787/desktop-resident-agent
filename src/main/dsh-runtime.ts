/** Minimal stdio JSON-RPC client for a DSH `sdk-minimal` runtime.
 *
 *  DSH is developer preview; its wire format is newline-delimited JSON-RPC.
 *  We deliberately keep this client dependency-free instead of using
 *  `@deepseek-ai/dsh-sdk-client`, whose pnpm dependency layout is fragile. */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export interface DshNotification {
  method: string
  params: Record<string, unknown>
}

export interface DshMcpBridgeSettings {
  /** Absolute path to `scripts/pet-mcp-bridge.cjs` (or its packaged copy). */
  script: string
  /** Loopback endpoint of the in-process tool bridge, if it is listening. */
  endpoint: () => { url: string; token: string } | null
}

export interface DshRuntimeSettings {
  /** Absolute path to `node_modules/@deepseek-ai/dsh/lib/bin.js`. */
  bin: string
  /** `DSH_HOME` for this app. */
  home: string
  cwd: string
  provider: string
  model: string
  maxTokens?: number
  systemPrompt?: string
  env?: NodeJS.ProcessEnv
  mcpBridge?: DshMcpBridgeSettings
}

function yamlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** The sdk-minimal bundle only ships a shell, `read_image`, and
 *  `working_directory`; the app's own tools need an explicit MCP client row.
 *  The patch file is owned by the desktop app because this DSH_HOME is its
 *  private data directory. */
export function writeDshProfile(home: string, bridge?: DshRuntimeSettings['mcpBridge']): void {
  const profile = path.join(home, 'profiles', 'sdk-minimal')
  mkdirSync(profile, { recursive: true })
  const packageFile = path.join(profile, 'package.json')
  if (!existsSync(packageFile)) {
    writeFileSync(packageFile, `${JSON.stringify({
      name: 'dsh-profile-sdk-minimal',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-sdk-minimal'] } }
    }, null, 2)}\n`, 'utf8')
  }
  const rootFile = path.join(profile, 'cordis.yml')
  if (!existsSync(rootFile)) {
    writeFileSync(rootFile, '[]\n', 'utf8')
  }
  const workspaceFile = path.join(profile, 'pnpm-workspace.yaml')
  if (!existsSync(workspaceFile)) {
    writeFileSync(workspaceFile, 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  }
  const endpoint = bridge?.endpoint()
  const lines = ['# Managed by the desktop app; edits here are overwritten on launch.', '[]' ]
  if (bridge && endpoint) {
    const script = bridge.script.replace(/\\/g, '/')
    lines.splice(lines.indexOf('[]'), 1,
      '- insert:',
      '    - id: mcp-pet',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: pet',
      '        transport: stdio',
      '        command: !!js process.execPath',
      '        args:',
      `          - ${yamlQuote(script)}`,
      '        env:',
      "          ELECTRON_RUN_AS_NODE: '1'",
      `          PET_BRIDGE_URL: ${yamlQuote(endpoint.url)}`,
      `          PET_BRIDGE_TOKEN: ${yamlQuote(endpoint.token)}`,
      '        failOnStartupError: true',
      '        toolCallTimeoutMs: 300000'
    )
  }
  writeFileSync(path.join(profile, 'cordis.patch.yml'), `${lines.join('\n')}\n`, 'utf8')
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function errorText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message)
  return String(value)
}

export class DshRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly listeners = new Set<(notification: DshNotification) => void>()
  private startPromise: Promise<void> | undefined
  private stderrTail = ''

  constructor(private readonly settings: DshRuntimeSettings) {}

  onNotification(listener: (notification: DshNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start(): Promise<void> {
    if (!this.startPromise) {
      this.startPromise = this.spawnAndInitialize().catch((error: unknown) => {
        this.startPromise = undefined
        throw error
      })
    }
    return this.startPromise
  }

  private async spawnAndInitialize(): Promise<void> {
    mkdirSync(this.settings.home, { recursive: true })
    writeDshProfile(this.settings.home, this.settings.mcpBridge)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.settings.env,
      DSH_HOME: this.settings.home,
      DSH_SYSTEM_PROMPT: this.settings.systemPrompt ?? 'You are XiaoJing, a helpful desktop coding assistant. Reply in the user language.',
      DEEPSEEK_API_KEY: this.settings.env?.DEEPSEEK_API_KEY ?? process.env.DEEPSEEK_API_KEY ?? ''
    }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [this.settings.bin, '--profile', 'sdk-minimal'], {
      cwd: this.settings.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    this.child = child
    this.stderrTail = ''
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4_000)
    })
    const lines = readline.createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))
    child.on('exit', (code) => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`DSH 运行时已退出（${code ?? 'unknown'}）${this.stderrTail ? `：${this.stderrTail}` : ''}`))
      }
      this.pending.clear()
      if (this.child === child) {
        this.child = undefined
        this.startPromise = undefined
      }
    })
    await this.request('initialize', {
      cwd: this.settings.cwd,
      provider: this.settings.provider,
      model: this.settings.model,
      ...(this.settings.maxTokens ? { maxTokens: this.settings.maxTokens } : {})
    }, 30_000)
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = typeof message.id === 'number' ? message.id : undefined
    if (id !== undefined && !('method' in message)) {
      const pending = this.pending.get(id)
      if (!pending) return
      this.pending.delete(id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`DSH ${errorText(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    const method = typeof message.method === 'string' ? message.method : ''
    if (!method) return
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {}
    for (const listener of this.listeners) listener({ method, params })
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error('DSH 运行时未启动。'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DSH 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  async prompt(sessionId: string, text: string): Promise<string> {
    const result = await this.request('session/prompt', {
      sessionId,
      contentBlocks: [{ type: 'text', text }]
    })
    const messageId = result && typeof result === 'object' && 'messageId' in result
      ? String((result as { messageId: unknown }).messageId) : ''
    if (!messageId) throw new Error('DSH 没有确认提示词已入队。')
    return messageId
  }

  waitForIdle(sessionId: string, timeoutMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        unsubscribe()
        signal.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve()
      }
      const unsubscribe = this.onNotification((notification) => {
        if (notification.method !== 'session.status') return
        if (notification.params.sessionId !== sessionId) return
        if (notification.params.status === 'idle') finish()
      })
      const onAbort = (): void => finish(new Error('已停止。'))
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => finish(new Error('DSH 回合超时。')), timeoutMs)
      timer.unref?.()
    })
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    try {
      await Promise.race([
        this.request('shutdown', {}),
        new Promise((resolve) => setTimeout(resolve, 1_000))
      ])
    } catch {
      // The process may already be gone.
    }
    this.child = undefined
    this.startPromise = undefined
    child.kill()
  }
}
