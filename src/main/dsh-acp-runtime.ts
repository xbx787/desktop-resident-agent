/** Minimal ACP (Agent Client Protocol) client for a DSH `acp` profile.
 *
 *  The `sdk-minimal` profile exposes only three tools and no permission or
 *  cancel surface. DSH's `acp` profile is the full base composition: every
 *  first-party tool, MCP declarations per session, `session/cancel`, and
 *  `session/request_permission`. That matches what desktop hosts such as
 *  DSH Desktop use, while the app keeps its own UI on top.
 *
 *  The wire is newline-delimited JSON-RPC 2.0 with server-to-client requests,
 *  so this client handles both directions. It is dependency-free on purpose:
 *  the ACP SDK is ESM-only and the app ships a CommonJS main bundle.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

export type DshAcpMcpServer =
  | {
    name: string
    command: string
    args: string[]
    env: Array<{ name: string; value: string }>
  }
  | {
    name: string
    type: 'http'
    url: string
    headers: Array<{ name: string; value: string }>
  }

/** ACP prompt blocks this client sends: text, plus images when the model
 *  declares image input. */
export type DshAcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string }

export interface DshAcpSettings {
  /** Absolute path to `node_modules/@deepseek-ai/dsh/lib/bin.js`. */
  bin: string
  /** `DSH_HOME` for this app. */
  home: string
  cwd: string
  env?: NodeJS.ProcessEnv
  systemPrompt?: string
  /** DSH sandbox preset: read-only / workspace-write / danger-full-access. */
  permissionMode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Declarations re-sent on every new/resumed session. */
  mcpServers?: () => DshAcpMcpServer[]
}

export interface DshAcpNotification {
  method: string
  params: Record<string, unknown>
}

export interface DshAcpServerRequest {
  method: string
  params: Record<string, unknown>
}

export interface DshAcpSession {
  sessionId: string
  configOptions?: unknown
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** ACP requires an absolute executable. Resolve a bare `npx`/`node` from PATH
 *  so a library entry written for Claude (which inherits PATH) still works. */
function absoluteCommand(command: string): string | null {
  if (path.isAbsolute(command)) return existsSync(command) ? command : null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue
    for (const extension of extensions) {
      const candidate = path.join(dir, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Convert one app library entry (Claude's mcpServers shape) to ACP. Returns
 *  null for an entry ACP could not start, so one bad row cannot reject the
 *  whole session. */
export function toAcpMcpServer(name: string, raw: unknown): DshAcpMcpServer | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const server = raw as Record<string, unknown>
  if (server.type === 'http' && typeof server.url === 'string' && /^https?:\/\//i.test(server.url)) {
    return { name, type: 'http', url: server.url, headers: [] }
  }
  if (typeof server.command !== 'string') return null
  const command = absoluteCommand(server.command)
  if (!command) return null
  const args = Array.isArray(server.args)
    ? server.args.filter((arg): arg is string => typeof arg === 'string') : []
  const rawEnv = server.env && typeof server.env === 'object' && !Array.isArray(server.env)
    ? server.env as Record<string, unknown> : {}
  const env = Object.entries(rawEnv)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([key, value]) => ({ name: key, value }))
  return { name, command, args, env }
}

function errorText(value: unknown): string {
  if (value && typeof value === 'object' && 'message' in value) return String((value as { message: unknown }).message)
  return String(value)
}

/** 只有子进程自己退出才算“可以透明重连”的故障；协议/参数错误不重试。 */
function isAcpExit(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('DSH ACP 已退出')
}

/** 真正会出现在回答里的通知；状态/命令列表更新不算“已经产出”。 */
function isSubstantiveActivity(method: string, params: Record<string, unknown>): boolean {
  if (method !== 'session/update') return false
  const update = params.update && typeof params.update === 'object'
    ? params.update as Record<string, unknown> : {}
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
  return kind === 'agent_message_chunk' || kind === 'agent_thought_chunk' ||
    kind === 'tool_call' || kind === 'tool_call_update' || kind === 'plan'
}

export class DshAcpRuntime {
  private child: ChildProcessWithoutNullStreams | undefined
  private nextId = 1
  private readonly pending = new Map<string, PendingRequest>()
  private readonly listeners = new Set<(notification: DshAcpNotification) => void>()
  private requestHandler: ((request: DshAcpServerRequest) => Promise<unknown>) | undefined
  private startPromise: Promise<void> | undefined
  private stderrTail = ''
  private runGeneration = 0
  /** 会话通知序号：prompt 重连前用它判断这一轮是否已经开始产出。 */
  private activitySerial = 0
  /** 连接握手时协商出的图片输入能力。 */
  private imagePrompts = false

  constructor(private readonly settings: DshAcpSettings) {}

  /** Increments whenever a fresh process has completed its handshake. */
  get generation(): number { return this.runGeneration }

  /** 供应商地址/Key 在进程启动时注入；只改环境，不在这里关闭进程，
   *  由调用方决定是立刻重启还是等当前回合结束。 */
  setDeepSeekEnvironment(patch: { apiKey?: string; baseUrl?: string }): void {
    const env = this.settings.env ?? (this.settings.env = {})
    if (patch.apiKey !== undefined) env.DEEPSEEK_API_KEY = patch.apiKey
    if (patch.baseUrl !== undefined) {
      const baseUrl = patch.baseUrl.trim()
      if (baseUrl) env.DEEPSEEK_BASE_URL = baseUrl
      else delete env.DEEPSEEK_BASE_URL
    }
  }

  /** The sandbox preset is a process-level env var too. */
  setPermissionMode(mode: 'read-only' | 'workspace-write' | 'danger-full-access'): void {
    if (this.settings.permissionMode === mode) return
    this.settings.permissionMode = mode
    if (this.child) void this.close()
  }

  /** The persona is a process-level env var; close now so the next turn
   *  starts a process that sees the new prompt. */
  setSystemPrompt(text: string): void {
    if (this.settings.systemPrompt === text) return
    this.settings.systemPrompt = text
    if (this.child) void this.close()
  }

  onNotification(listener: (notification: DshAcpNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setRequestHandler(handler: (request: DshAcpServerRequest) => Promise<unknown>): void {
    this.requestHandler = handler
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
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.settings.env,
      DSH_HOME: this.settings.home,
      ...(this.settings.systemPrompt ? { DSH_SYSTEM_PROMPT: this.settings.systemPrompt } : {}),
      ...(this.settings.permissionMode ? { DSH_PERMISSION_MODE: this.settings.permissionMode } : {})
    }
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawn(process.execPath, [this.settings.bin, '--profile', 'acp'], {
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
        pending.reject(new Error(`DSH ACP 已退出（${code ?? 'unknown'}）${this.stderrTail ? `：${this.stderrTail}` : ''}`))
      }
      this.pending.clear()
      if (this.child === child) {
        this.child = undefined
        this.startPromise = undefined
      }
    })
    const initialized = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      }
    }, 30_000) as {
      protocolVersion?: number
      agentCapabilities?: { promptCapabilities?: { image?: boolean } }
    }
    if (initialized?.protocolVersion !== 1) {
      throw new Error('DSH ACP 协议版本不匹配。')
    }
    this.imagePrompts = initialized.agentCapabilities?.promptCapabilities?.image === true
    this.runGeneration += 1
  }

  /** 连接级图片能力：DSH 只有在模型声明多模态时才为 true。 */
  get supportsImagePrompts(): boolean {
    return this.imagePrompts
  }

  private write(message: unknown): void {
    const child = this.child
    if (!child || child.killed) return
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const method = typeof message.method === 'string' ? message.method : ''
    const id = message.id
    const hasId = id !== undefined && id !== null
    if (method && hasId) {
      const params = message.params && typeof message.params === 'object'
        ? message.params as Record<string, unknown> : {}
      const handler = this.requestHandler
      void (handler
        ? handler({ method, params })
        : Promise.reject(new Error(`未实现的 ACP 请求：${method}`))
      ).then(
        (result) => this.write({ jsonrpc: '2.0', id, result }),
        (error: unknown) => this.write({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) }
        })
      )
      return
    }
    if (hasId && !method) {
      const pending = this.pending.get(String(id))
      if (!pending) return
      this.pending.delete(String(id))
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(`DSH ACP ${errorText(message.error)}`))
      else pending.resolve(message.result)
      return
    }
    if (!method) return
    const params = message.params && typeof message.params === 'object'
      ? message.params as Record<string, unknown> : {}
    if (isSubstantiveActivity(method, params)) this.activitySerial += 1
    for (const listener of this.listeners) listener({ method, params })
  }

  request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const child = this.child
    if (!child || child.killed) return Promise.reject(new Error('DSH ACP 运行时未启动。'))
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DSH ACP 请求超时：${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  private mcpServers(): DshAcpMcpServer[] {
    try {
      return this.settings.mcpServers?.() ?? []
    } catch {
      return []
    }
  }

  async newSession(cwd: string): Promise<DshAcpSession> {
    return await this.request('session/new', {
      cwd,
      mcpServers: this.mcpServers()
    }, 120_000) as DshAcpSession
  }

  async resumeSession(sessionId: string, cwd: string): Promise<DshAcpSession> {
    return await this.request('session/resume', {
      sessionId,
      cwd,
      mcpServers: this.mcpServers()
    }, 120_000) as DshAcpSession
  }

  async prompt(sessionId: string, blocks: DshAcpPromptBlock[], timeoutMs = 30 * 60_000): Promise<{ stopReason?: string }> {
    // ACP 进程偶发退出时，用户不应该看到“DSH ACP 已退出”。如果这次 prompt
    // 还没有产生任何会话通知，就静默重启进程、恢复同一会话并重放一次；
    // 中途已经流式输出则不重放，避免重复回答。
    let target = sessionId
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const activity = this.activitySerial
      try {
        return await this.request('session/prompt', {
          sessionId: target,
          prompt: blocks
        }, timeoutMs) as { stopReason?: string }
      } catch (error) {
        if (!isAcpExit(error) || this.activitySerial !== activity || attempt === 2) {
          if (isAcpExit(error)) {
            throw new Error('连接刚刚中断，自动恢复没有成功。消息已保留，请再发送一次。')
          }
          throw error
        }
        await this.close().catch(() => undefined)
        await new Promise<void>((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
        await this.start()
        const resumed = await this.resumeSession(target, this.settings.cwd)
        target = resumed.sessionId || target
      }
    }
    throw new Error('连接刚刚中断，自动恢复没有成功。消息已保留，请再发送一次。')
  }
  /** 把我们补的 `session/steer` 打给 DSH：消息插到下一步边界，不打断当前
   *  回合。方法不存在（未打补丁的运行时）时抛错，由调用方回退。 */
  async steer(sessionId: string, blocks: DshAcpPromptBlock[], timeoutMs = 30_000): Promise<{ queued: boolean; messageId?: string }> {
    const result = await this.request('session/steer', {
      sessionId,
      prompt: blocks
    }, timeoutMs) as { queued?: boolean; messageId?: string }
    return {
      queued: result?.queued === true,
      ...(typeof result?.messageId === 'string' ? { messageId: result.messageId } : {})
    }
  }

  /** 手动压缩：走我们补的 `session/compact`。 */
  async compact(sessionId: string, timeoutMs = 180_000): Promise<{ shadowed?: number; tokens?: number }> {
    return await this.request('session/compact', { sessionId }, timeoutMs) as { shadowed?: number; tokens?: number }
  }

  /** 按需读取实时上下文占用：走我们补的 `session/usage`，压缩后立即拿到新值。 */
  async usage(sessionId: string, timeoutMs = 30_000): Promise<{ used?: number; size?: number }> {
    return await this.request('session/usage', { sessionId }, timeoutMs) as { used?: number; size?: number }
  }

  /** 把计划模式开关交给 DSH 的 planMode 服务（我们补的 `session/plan`）。 */
  async setPlan(sessionId: string, active: boolean, timeoutMs = 30_000): Promise<boolean> {
    const result = await this.request('session/plan', { sessionId, active }, timeoutMs) as { active?: boolean }
    return result?.active === true
  }

  /** 把一批回答交给我们补的 `session/answer`；问题已关闭时返回 false。 */
  async answer(sessionId: string, callId: string, answers: unknown[], timeoutMs = 60_000): Promise<boolean> {
    const result = await this.request('session/answer', { sessionId, callId, answers }, timeoutMs) as { accepted?: boolean }
    return result?.accepted === true
  }

  async cancel(sessionId: string): Promise<void> {
    this.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.request('session/close', { sessionId }, 30_000).catch(() => undefined)
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = undefined
    this.startPromise = undefined
    try { child.stdin.end() } catch { /* already closed */ }
    await new Promise<void>((resolve) => setTimeout(resolve, 200))
    if (!child.killed) child.kill()
  }
}
