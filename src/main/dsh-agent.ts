/** ModelClient adapter for a DeepSeek Harness `sdk-minimal` runtime.
 *
 *  The UI/runtime still speak the existing ModelClient callbacks; DSH events
 *  are translated here. This is a gray-switch kernel: Claude remains the
 *  default until this adapter passes the same real-task checks. */

import { randomUUID } from 'node:crypto'
import type { ModelClient, ModelReply, ModelToolEvent, DialogueLine } from './deepseek'
import type { ConversationBridge } from './conversation-tools'
import type { EvolveBridge } from './evolve-tools'
import { resolveDeepSeekToolsKey } from './deepseek-tools'
import type { PetMcpBridge } from './pet-mcp-server'
import type { CompactionState, TaskUsage } from '../shared/contracts'
import type { DshNotification, DshRuntime } from './dsh-runtime'
import { normalizeDshModel } from './dsh-model'

const TURN_TIMEOUT_MS = 30 * 60_000

export interface DshAgentOptions {
  runtime: DshRuntime
  bridge: PetMcpBridge
  provider?: string
  model?: string
  cwd: string
  maxTokens?: number
}

interface MessageBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  isError?: boolean
  content?: Array<{ type?: string; text?: string }>
}

function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => block && typeof block === 'object' && typeof (block as MessageBlock).text === 'string'
      ? (block as MessageBlock).text! : '')
    .join('')
}

function addUsage(total: TaskUsage, raw: unknown): TaskUsage {
  if (!raw || typeof raw !== 'object') return total
  const value = raw as Record<string, unknown>
  const number = (key: string): number => typeof value[key] === 'number' && Number.isFinite(value[key]) ? Number(value[key]) : 0
  const input = number('inputTokens') || number('input')
  const output = number('outputTokens') || number('output')
  const cacheRead = number('cacheReadTokens')
  const cacheCreate = number('cacheWriteTokens')
  return {
    total: total.total + (number('totalTokens') || input + output + cacheRead + cacheCreate),
    input: (total.input ?? 0) + input,
    output: (total.output ?? 0) + output,
    cacheRead: (total.cacheRead ?? 0) + cacheRead,
    cacheCreate: (total.cacheCreate ?? 0) + cacheCreate
  }
}

export class DshAgentClient implements ModelClient {
  /** The app runs the /goal loop because sdk-minimal has no goal driver. */
  readonly goalMode = 'local'
  private sessionId: string | null = null
  private provider: string
  private model: string
  private maxTokens: number | undefined
  private compactingListener: ((state: CompactionState) => void) | undefined

  constructor(private readonly options: DshAgentOptions) {
    this.provider = options.provider ?? 'deepseek-official'
    this.model = normalizeDshModel(options.model)
    this.maxTokens = options.maxTokens
  }

  private get runtime(): DshRuntime { return this.options.runtime }
  private get bridge(): PetMcpBridge { return this.options.bridge }

  async respond(
    history: DialogueLine[],
    signal: AbortSignal,
    onProgress?: (text: string, segment?: number) => void,
    sdkSessionId?: string | null,
    onToolEvent?: (event: ModelToolEvent) => void,
    onTaskUsage?: (usage: TaskUsage) => void,
    onThinking?: (text: string, segment?: number) => void
  ): Promise<ModelReply> {
    if (signal.aborted) throw new Error('已停止。')
    const latestUser = [...history].reverse().find((line) => line.role === 'user')?.content
    if (!latestUser) throw new Error('没有可发送的用户消息。')

    await this.bridge.start()
    await this.runtime.start()
    const sessionId = sdkSessionId || this.sessionId || `whale-${randomUUID()}`
    if (!this.sessionId && sdkSessionId) {
      // Restore the persisted DSH session if it exists; an unknown id is
      // created lazily by session/prompt.
      await this.runtime.request('session/resume', { sessionId }, 30_000).catch(() => undefined)
    }
    this.sessionId = sessionId

    let finalText = ''
    let usage: TaskUsage = { total: 0 }
    let interrupted = false
    let segment = 0
    const startedAt = Date.now()
    const toolNames = new Map<string, string>()
    const onNotification = (notification: DshNotification): void => {
      if (notification.method !== 'session.event') return
      if (notification.params.sessionId !== sessionId) return
      const event = notification.params.event
      if (!event || typeof event !== 'object') return
      const record = event as { type?: string; data?: Record<string, unknown> }
      const data = record.data ?? {}
      if (record.type === 'assistant/message') {
        const message = data.message as { content?: MessageBlock[] } | undefined
        const text = textFromContent(message?.content)
        const thinking = (message?.content ?? [])
          .filter((block) => block.type === 'reasoning' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (thinking) onThinking?.(thinking, segment)
        if (text) {
          finalText = text
          onProgress?.(text, segment)
          segment += 1
        }
        if (data.usage) {
          usage = addUsage(usage, data.usage)
          onTaskUsage?.(usage)
        }
      } else if (record.type === 'tool/call') {
        const callId = String(data.callId ?? '')
        const name = String(data.name ?? '')
        if (callId && name) toolNames.set(callId, name)
        onToolEvent?.({
          toolUseId: callId,
          toolName: name,
          phase: 'start',
          input: typeof data.arguments === 'string' ? data.arguments : undefined
        })
      } else if (record.type === 'compaction/start') {
        this.compactingListener?.({ active: true, auto: true })
      } else if (record.type === 'compaction/end') {
        this.compactingListener?.({ active: false, auto: true })
      } else if (record.type === 'tool/result') {
        const message = data.message as { toolCallId?: string; isError?: boolean; content?: MessageBlock[] } | undefined
        const callId = String(message?.toolCallId ?? '')
        onToolEvent?.({
          toolUseId: callId,
          toolName: toolNames.get(callId) ?? '',
          phase: 'result',
          output: textFromContent(message?.content),
          isError: Boolean(data.error || message?.isError)
        })
        toolNames.delete(callId)
      }
    }

    const unsubscribe = this.runtime.onNotification(onNotification)
    const onAbort = (): void => {
      interrupted = true
      void this.runtime.close()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) interrupted = true
    try {
      if (!interrupted) {
        await this.runtime.prompt(sessionId, latestUser)
        await this.runtime.waitForIdle(sessionId, TURN_TIMEOUT_MS, signal)
      }
    } catch (error) {
      if (signal.aborted) interrupted = true
      else throw error
    } finally {
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
    }

    return {
      text: finalText,
      sdkSessionId: sessionId,
      interrupted,
      generationMs: Date.now() - startedAt
    }
  }

  // sdk-minimal has no approval, plan, or question wire messages yet. Keep the
  // methods so the runtime can call them uniformly; the UI still shows the
  // selected tier, but only the tools the model can reach are mediated.
  setApprovalMode(_mode: unknown): boolean { return true }
  setPlanMode(_on: boolean): boolean { return true }
  setEffort(_level: unknown): void {}
  setCompactingListener(listener?: (state: CompactionState) => void): void {
    this.compactingListener = listener
  }
  setWebSearchEnabled(_on: boolean): void {}
  setAutoCompactPercent(_percent: number): void {}
  setLibraries(_servers: Record<string, unknown>, _plugins: string[]): void {}
  setPersonaId(_id: string): void {}
  setOutputStyle(_style?: string): void {}
  setAppendSystemPrompt(_text?: string): void {}
  setLoadUserSettings(_on: boolean): void {}
  setProvider(provider?: { baseUrl: string; apiKey: string; model: string; smallModel?: string; extraEnv?: string }): void {
    if (provider?.model) this.model = provider.model
    if (provider) this.bridge.setDeepSeekApiKey(resolveDeepSeekToolsKey(provider))
  }
  setIdentity(_identity?: { userName?: string; assistantName?: string }): void {}
  setConversationBridge(bridge?: ConversationBridge): void {
    this.bridge.setConversationBridge(bridge)
  }
  setEvolveBridge(bridge?: EvolveBridge): void {
    this.bridge.setEvolveBridge(bridge)
  }
  async interrupt(): Promise<void> { await this.runtime.close() }

  async dispose(): Promise<void> {
    await this.runtime.close().catch(() => undefined)
    await this.bridge.close().catch(() => undefined)
  }
}
