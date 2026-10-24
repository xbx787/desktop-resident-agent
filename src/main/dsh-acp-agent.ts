/** ModelClient adapter for the DSH `acp` profile.
 *
 *  Unlike `sdk-minimal`, ACP exposes the full DSH base composition: every
 *  first-party tool, per-session MCP declarations, cancellation, and one-shot
 *  permission prompts. The desktop app keeps its own UI and maps ACP updates
 *  onto the existing `ModelClient` callbacks.
 */

import { statSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { ModelClient, ModelImage, ModelReply, ModelToolEvent, DialogueLine } from './deepseek'
import type {
  ApprovalMode,
  AskAnswers,
  AskQuestion,
  AskQuestionRequest,
  ContextUsageSnapshot,
  EffortLevel,
  SubagentTask,
  TaskUsage,
  TimelineEntry,
  ToolPermissionRequest
} from '../shared/contracts'
import type { ConversationBridge } from './conversation-tools'
import type { EvolveBridge } from './evolve-tools'
import { resolveDeepSeekToolsKey } from './deepseek-tools'
import { buildPersona } from './persona'
import { toolLabel } from '../shared/tool-labels'
import { syncDshSkills } from './dsh-skills'
import { syncDshAcpModelPatch, syncDshCompactPatch, syncDshGoalToolPatch, syncDshWebPatch } from './dsh-web-policy'
import { normalizeDshModel } from './dsh-model'
import { buildDshHostRules } from './dsh-prompt'
import { findDshSessionLog, readDshSessionUsage, subtractUsage, type DshSessionUsage } from './dsh-session-log'
import type { PetMcpBridge } from './pet-mcp-server'
import type { DshAcpNotification, DshAcpPromptBlock, DshAcpRuntime, DshAcpServerRequest } from './dsh-acp-runtime'

const TURN_TIMEOUT_MS = 30 * 60_000
const MAX_PERMISSION_INPUT = 4_000
/** 提问卡没有时限地挂着会让整轮和后续消息都排不进来；DSH 原生阻塞提问
 *  本身不会超时，宿主必须自己兜底。十分钟足够读完问题，也不会永远卡住。 */
const QUESTION_TIMEOUT_MS = 10 * 60_000

export interface DshAcpAgentOptions {
  runtime: DshAcpRuntime
  bridge: PetMcpBridge
  cwd: string
  provider?: string
  model?: string
  /** Anthropic 兼容端点；写入 DSH 进程的 DEEPSEEK_BASE_URL。 */
  baseUrl?: string
  deepseekApiKey?: string
  personaId?: string
  identity?: { userName?: string; assistantName?: string }
  dshHome: string
  /** Shared with the runtime's mcpServers callback; setLibraries fills it. */
  libraries?: { mcp: Record<string, unknown>; plugins: string[] }
}

interface PendingPermission {
  resolve: (optionId: string | null) => void
  allowOptionId: string
  rejectOptionId: string
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {}
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function chunkText(content: unknown): string {
  const block = objectValue(content)
  return block.type === 'text' ? textValue(block.text) : ''
}

/** ACP tool content is an array of content blocks; diffs and terminals carry
 *  no text the transcript can show, so only text blocks are joined. */
function toolOutput(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    const outer = objectValue(item)
    if (outer.type === 'content') {
      const inner = objectValue(outer.content)
      if (inner.type === 'text' && typeof inner.text === 'string') parts.push(inner.text)
    } else if (outer.type === 'text' && typeof outer.text === 'string') {
      parts.push(outer.text)
    }
  }
  return parts.join('\n')
}

/** 子代理事件里的 output：字符串直接收，content 数组只取文本块。 */
function toolEventOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((block) => {
      const item = objectValue(block)
      return item.type === 'text' ? textValue(item.text) : ''
    }).filter(Boolean).join('\n')
  }
  return value === undefined ? '' : JSON.stringify(value)
}

/** 面板的答案 map（键 = 问题 key）转成 DSH 的答案批次。 */
function answerBatch(questions: AskQuestion[], answers: AskAnswers | null): Array<{ id: string; selected: string[]; custom?: string }> {
  return questions.map((question) => {
    const value = answers?.[question.key]
    const picked = Array.isArray(value) ? value : value ? [value] : []
    const labels = question.options.map((option) => option.label)
    const selected = picked.filter((item) => labels.includes(item))
    const custom = picked.filter((item) => item && !labels.includes(item)).join('\n') || undefined
    return { id: question.key, selected, ...(custom ? { custom } : {}) }
  })
}

const READ_ONLY_KINDS = new Set(['read', 'search', 'think', 'fetch'])

/** DSH labels most first-party tools with kind `other`, so a title-based
 *  fallback keeps the app's plan/accept-edits policy meaningful. */
function effectiveToolKind(kind: string, title: string): string {
  const name = title.toLowerCase()
  if (/pwsh|powershell|bash|shell|terminal|execute|command/.test(name)) return 'execute'
  if (/write|edit|replace|patch|create_file/.test(name)) return 'edit'
  if (/read|list|glob|grep|search|fetch|working_directory/.test(name)) return 'read'
  return kind || 'other'
}

/** DSH 里会派生一个子代理的工具名：单次 subagent 和 fork 版。 */
const SUBAGENT_TOOL = /^(subagent|subagent[_-]?fork|task|agent)$/iu

/** 提问工具的名字在不同 ACP 版本里可能是 `ask_user_question`、`AskUserQuestion`
 *  或带标题前缀的展示名；只在标题看起来确实是提问工具时才解析。 */
function isAskQuestionTool(name: string): boolean {
  const trimmed = name.trim()
  return /^ask[\s_-]?user([\s_-]?question)?$/iu.test(trimmed) ||
    /(?:^|[\s_-])ask[\s_-]?user[\s_-]?question(?:$|[\s_-])/iu.test(trimmed)
}

/** 同一次提问会先以工具调用出现，再以服务请求出现；比较正文就能认出
 *  是同一张卡，避免面板被同一条问题替换两次。 */
function sameQuestions(left: AskQuestion[], right: AskQuestion[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return item.key === other.key &&
      item.question === other.question &&
      item.multiSelect === other.multiSelect &&
      item.options.length === other.options.length &&
      item.options.every((option, optionIndex) => option.label === other.options[optionIndex]?.label)
  })
}

function isSubagentTool(name: string): boolean {
  return SUBAGENT_TOOL.test(name.trim())
}

export class DshAcpAgentClient implements ModelClient {
  /** ACP exposes tools but no goal driver; the app runs the loop. */
  readonly goalMode = 'local'
  private sessionId: string | null = null
  private provider: string
  private model: string
  /** 当前配置的供应商地址；空串表示 DSH 默认官方端点。 */
  private providerBaseUrl: string
  /** 切换供应商地址后等当前回合结束再重启进程。 */
  private pendingProviderRestart = false
  private effort: EffortLevel = 'max'
  private approvalMode: ApprovalMode = 'workspace-write'
  private planMode = false
  private busy = false
  private permissionListener: ((request: ToolPermissionRequest | null) => void) | undefined
  private readonly pendingPermissions = new Map<string, PendingPermission>()
  /** 插话回显：DSH 把 steer 的用户消息写进会话后，用它确认投递。 */
  private steerEchoListener?: (messageId: string) => void
  private lastContextUsage: ContextUsageSnapshot = { status: 'unavailable' }
  private personaId: string
  private identity: { userName?: string; assistantName?: string }
  private sessionGeneration = -1
  private appliedOptionsKey = ''
  /** 联网搜索：false 时把 DSH 的 web 工具从下一轮会话里移除。 */
  private webSearchEnabled = true
  /** 自动压缩阈值（50–90），写入 DSH 的 compaction-basic；-1 表示还没同步过。 */
  private autoCompactPercent = -1
  /** 设置里的“输出风格”和“追加指令”，DSH 没有这两个概念，拼进系统提示。 */
  private outputStyle = ''
  private appendSystemPrompt = ''
  /** 人设 + 宿主规则：每轮跟在用户消息前面送进模型（见 respond）。 */
  private promptPreamble = ''
  /** 开关在回合进行中被改动：等这一轮结束后重建进程，不打断回答。 */
  private pendingRestart = false
  private subagentListener?: (tasks: SubagentTask[]) => void
  /** DSH 的子代理是一层工具调用，这里按工具 id 记成托盘里的任务。 */
  private readonly subagentTasks = new Map<string, SubagentTask>()
  /** 当前在等回答的提问工具调用；回答时用它把标签映射回 id。 */
  private questionListener?: (question: AskQuestionRequest | null) => void
  private pendingAsk: { callId: string; request: AskQuestionRequest } | null = null
  /** 服务级提问（例如退出计划模式）：等宿主面板回答后直接把答案交回服务。 */
  private pendingHostQuestion: { id: string; questions: AskQuestion[]; resolve: (value: unknown) => void; reject: (error: Error) => void } | null = null
  /** 无人回答时的兜底计时器；回答、打断或替换问题时清掉。 */
  private questionTimer?: ReturnType<typeof setTimeout>
  private planModeListener?: (on: boolean) => void
  private lastSessionUsage: DshSessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  /** Size of the session log at the last usage read; lets the live poll skip
   *  re-decompressing a file that has not grown since. */
  private usageLogSize = -1
  /** ACP permission requests carry only the tool-call id; keep the earlier
   *  tool_call payload so the panel can name the action and show its input. */
  private readonly toolCallInfo = new Map<string, { title: string; input: string; kind: string }>()

  constructor(private readonly options: DshAcpAgentOptions) {
    this.provider = options.provider ?? 'deepseek-official'
    this.model = normalizeDshModel(options.model)
    this.providerBaseUrl = options.baseUrl?.trim() ?? ''
    this.runtime.setDeepSeekEnvironment?.({ apiKey: options.deepseekApiKey, baseUrl: this.providerBaseUrl })
    this.personaId = options.personaId ?? 'xiaojing'
    this.identity = options.identity ?? {}
    this.bridge.setDeepSeekApiKey(options.deepseekApiKey)
    // 目标由宿主循环管理：把 DSH 自带的目标工具从会话里去掉。
    try { syncDshGoalToolPatch(options.dshHome) } catch { /* 写盘失败不阻断 */ }
    this.runtime.setRequestHandler((request) => this.handleServerRequest(request))
    this.applyPersona()
  }

  private applyPersona(): void {
    const persona = buildPersona(this.personaId, {
      userAddress: this.identity.userName,
      assistantName: this.identity.assistantName
    })
    // 人设正文和宿主规则分开维护：规则在 dsh-prompt.ts，可单独测试。
    const hostRules = buildDshHostRules({
      webSearchEnabled: this.webSearchEnabled,
      outputStyle: this.outputStyle,
      appendSystemPrompt: this.appendSystemPrompt
    })
    this.promptPreamble = `${persona}${hostRules}`
    // 仍然写进进程环境：sdk-minimal 的 profile 用 personaPrefix 读它，
    // ACP 侧则等 DSH 支持后再切回系统提示。
    this.runtime.setSystemPrompt(this.promptPreamble)
  }

  private get runtime(): DshAcpRuntime { return this.options.runtime }
  private get bridge(): PetMcpBridge { return this.options.bridge }

  async respond(
    history: DialogueLine[],
    signal: AbortSignal,
    onProgress?: (text: string, segment?: number) => void,
    sdkSessionId?: string | null,
    onToolEvent?: (event: ModelToolEvent) => void,
    onTaskUsage?: (usage: TaskUsage) => void,
    onThinking?: (text: string, segment?: number) => void,
    images?: ModelImage[]
  ): Promise<ModelReply> {
    if (signal.aborted) throw new Error('已停止。')
    // 人设文件（data/persona/<id>.md）可能刚被改过：每轮重读一次，文本没变
    // 时 setSystemPrompt 不会动进程，变了下一轮就带上新文本。
    this.applyPersona()
    // 联网/压缩设置或联网开关在上一轮进行中改动过：等回合结束再重建进程。
    if (this.pendingRestart) {
      this.pendingRestart = false
      this.resetSession()
      this.applyPersona()
      await this.runtime.close().catch(() => undefined)
    }
    // 地址/Key 在回合中改过：下一轮换新进程，但保留会话 id 继续续接上下文。
    if (this.pendingProviderRestart) {
      this.pendingProviderRestart = false
      await this.runtime.close().catch(() => undefined)
    }
    // 上一轮结束的子代理不带到这一轮。
    this.pruneFinishedSubagents()
    const latestUser = [...history].reverse().find((line) => line.role === 'user')?.content
    if (!latestUser) throw new Error('没有可发送的用户消息。')

    await this.bridge.start()
    this.runtime.setPermissionMode(this.planMode ? 'read-only' : this.permissionForMode(this.approvalMode))
    // DSH 在 initialize 握手时就用 profile 默认模型判断图片能力；必须在进程
    // 启动前把模型钉到目录里的 id，否则会回 image:false。
    try {
      syncDshAcpModelPatch(this.options.dshHome, this.provider, this.model, this.providerBaseUrl)
    } catch (error) {
      throw new Error(`无法写入 DSH 模型配置：${error instanceof Error ? error.message : String(error)}`)
    }
    await this.runtime.start()
    const sessionId = await this.ensureSession(sdkSessionId)
    // Baseline this session's durable token counters before the new turn, so
    // a resumed transcript is not billed as if this turn produced it.
    const baselineLog = findDshSessionLog(this.options.dshHome, sessionId)
    this.lastSessionUsage = baselineLog
      ? readDshSessionUsage(baselineLog)
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    this.usageLogSize = -1
    await this.applySessionOptions(sessionId)

    // 一轮的累计用量：DSH 日志只给增量，这里累加后交给界面。轮中每秒读一次，
    // 中途停止时界面上也能留下已经产生的真实用量，而不是“未记录”。
    let turnUsage = { total: 0, input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
    let usageReading = false
    const reportUsage = async (attempts: number): Promise<void> => {
      if (usageReading) return
      usageReading = true
      try {
        const delta = await this.readUsageDelta(sessionId, attempts)
        if (!delta || delta.total <= 0) return
        turnUsage = {
          total: turnUsage.total + delta.total,
          input: turnUsage.input + delta.input,
          output: turnUsage.output + delta.output,
          cacheRead: turnUsage.cacheRead + delta.cacheRead,
          cacheCreate: turnUsage.cacheCreate + delta.cacheWrite
        }
        onTaskUsage?.({ ...turnUsage })
      } catch {
        // 日志暂时读不到不影响这一轮。
      } finally {
        usageReading = false
      }
    }
    const usageTimer = setInterval(() => { void reportUsage(1) }, 1000)
    usageTimer.unref?.()

    let interrupted = false
    const startedAt = Date.now()
    // 与 Claude 路径同一口径：只累计真正在流式生成的时间，间隔超过 1.5 秒
    // （工具执行、等待用户、审批）就不计入。速率 = 输出 token ÷ 这个时长。
    let generationActiveMs = 0
    let lastGenerationAt: number | undefined
    const noteGenerationDelta = (): void => {
      const now = Date.now()
      if (lastGenerationAt !== undefined) {
        const gap = now - lastGenerationAt
        if (gap >= 0 && gap <= 1_500) generationActiveMs += gap
      }
      lastGenerationAt = now
    }
    const messageTexts = new Map<number, string>()
    let messageSegment = -1
    let currentMessageId = ''
    /** 最后一次工具调用发生在哪一段文字之后：这之后的文字才是这一轮的回答。
     *  之前的都是过程旁白，拼接起来会把整轮旁白当成答复重复一遍。 */
    let lastToolSegment = -1
    const thoughtTexts = new Map<number, string>()
    let thoughtSegment = -1
    let currentThoughtId = ''
    const toolNames = new Map<string, string>()

    const onNotification = (notification: DshAcpNotification): void => {
      if (notification.method === 'session/subagent_event') {
        this.handleSubagentEvent(notification.params, sessionId)
        return
      }
      if (notification.method !== 'session/update') return
      const params = notification.params
      if (params.sessionId !== sessionId) return
      const update = objectValue(params.update)
      const kind = textValue(update.sessionUpdate)
      if (kind === 'user_message') {
        // steer 的消息被 DSH 真正写进会话后回显；用它确认投递，不重新渲染用户消息。
        const echoed = textValue(update.messageId) || textValue(update.message_id)
        if (echoed) this.steerEchoListener?.(echoed)
        return
      }
      if (kind === 'agent_message_chunk') {
        const id = textValue(update.messageId)
        if (id && id !== currentMessageId) {
          currentMessageId = id
          messageSegment += 1
        }
        if (messageSegment < 0) messageSegment = 0
        const next = (messageTexts.get(messageSegment) ?? '') + chunkText(update.content)
        messageTexts.set(messageSegment, next)
        noteGenerationDelta()
        if (next) onProgress?.(next, messageSegment)
      } else if (kind === 'agent_thought_chunk') {
        const id = textValue(update.messageId)
        if (id && id !== currentThoughtId) {
          currentThoughtId = id
          thoughtSegment += 1
        }
        if (thoughtSegment < 0) thoughtSegment = 0
        const next = (thoughtTexts.get(thoughtSegment) ?? '') + chunkText(update.content)
        thoughtTexts.set(thoughtSegment, next)
        noteGenerationDelta()
        if (next) onThinking?.(next, thoughtSegment)
      } else if (kind === 'tool_call') {
        lastToolSegment = messageSegment
        const toolCallId = textValue(update.toolCallId)
        const title = textValue(update.title) || 'unknown_tool'
        const input = update.rawInput === undefined ? '' : JSON.stringify(update.rawInput)
        if (toolCallId) {
          toolNames.set(toolCallId, title)
          this.toolCallInfo.set(toolCallId, { title, input, kind: textValue(update.kind) })
          if (isSubagentTool(title)) this.startSubagentTask(toolCallId, title, update.rawInput)
          this.maybeStartQuestion(toolCallId, title, update.rawInput)
        }
        onToolEvent?.({
          toolUseId: toolCallId,
          toolName: title,
          kind: textValue(update.kind),
          phase: 'start',
          input: update.rawInput === undefined ? undefined : input
        })
      } else if (kind === 'tool_call_update') {
        const toolCallId = textValue(update.toolCallId)
        const status = textValue(update.status)
        if (status !== 'completed' && status !== 'failed') return
        const output = toolOutput(update.content) ||
          (update.rawOutput === undefined ? '' : JSON.stringify(update.rawOutput))
        if (toolCallId && this.subagentTasks.has(toolCallId)) {
          this.finishSubagentTask(toolCallId, status === 'failed', output)
        }
        if (toolCallId && this.pendingAsk?.callId === toolCallId) {
          this.pendingAsk = null
          this.questionListener?.(null)
        }
        onToolEvent?.({
          toolUseId: toolCallId,
          toolName: toolNames.get(toolCallId) ?? '',
          kind: toolCallId ? this.toolCallInfo.get(toolCallId)?.kind : undefined,
          phase: 'result',
          output,
          isError: status === 'failed'
        })
        toolNames.delete(toolCallId)
        this.toolCallInfo.delete(toolCallId)
      } else if (kind === 'usage_update') {
        const used = typeof update.used === 'number' ? update.used : 0
        const size = typeof update.size === 'number' ? update.size : 0
        this.lastContextUsage = this.contextUsageFrom(used, size)
      }
    }

    const unsubscribe = this.runtime.onNotification(onNotification)
    const onAbort = (): void => {
      interrupted = true
      void this.runtime.cancel(sessionId)
    }
    // 图片块只在握手声明支持时发送；不支持的模型仍能从文本里的路径用读图工具打开。
    // ACP 内核不消费 DSH_SYSTEM_PROMPT（只有 sdk-minimal 的 profile 读它），
    // 所以人设和宿主规则跟着用户消息一起送进去：这是实测能到达模型的通道。
    const promptText = this.promptPreamble ? `${this.promptPreamble}\n\n---\n\n${latestUser}` : latestUser
    const promptBlocks: DshAcpPromptBlock[] = [{ type: 'text', text: promptText }]
    if (this.runtime.supportsImagePrompts) {
      for (const image of images ?? []) {
        promptBlocks.push({ type: 'image', mimeType: image.mimeType, data: image.data })
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.busy = true
    // The runtime handshake can outlive a quick stop. Never enqueue a prompt
    // the user already cancelled before the process was ready.
    if (signal.aborted) interrupted = true
    try {
      if (!interrupted) {
        const result = await this.runtime.prompt(sessionId, promptBlocks, TURN_TIMEOUT_MS)
        if (result.stopReason === 'cancelled') interrupted = true
      }
    } catch (error) {
      if (signal.aborted) interrupted = true
      else throw error
    } finally {
      clearInterval(usageTimer)
      this.busy = false
      // 取消/异常结束时 DSH 可能不再回 tool_call_update；这里主动收尾，
      // 保证下一次提问不会继承一张已经失效的卡。
      if (this.pendingHostQuestion || this.pendingAsk) {
        this.settleQuestions('本轮已结束，未回答的问题已取消。')
      }
      unsubscribe()
      signal.removeEventListener('abort', onAbort)
    }

    // 收尾再等一次落盘，补上最后一条 assistant/message 的用量。
    await reportUsage(25)
    // 这一轮的回答只取最后一次工具调用之后的文字。把所有段落拼起来会让
    // 界面把整轮过程旁白当成答复再重复一遍（实测过，见 #1）。
    const ordered = [...messageTexts.entries()]
      .sort(([a], [b]) => a - b)
      .filter(([, value]) => value.trim())
    const afterTool = ordered.filter(([index]) => index > lastToolSegment)
    const answer = afterTool.length ? afterTool : ordered.slice(-1)
    const text = answer.map(([, value]) => value).join('\n\n')
    return {
      text,
      sdkSessionId: sessionId,
      interrupted,
      generationMs: generationActiveMs > 0 ? generationActiveMs : Date.now() - startedAt
    }
  }

  /** The durable log may be flushed a beat after the prompt settles. Poll a
   *  few times for a larger total instead of reporting zero tokens. `attempts`
   *  is 1 for the once-a-second live read: that one must not block. */
  private async readUsageDelta(sessionId: string, attempts = 25): Promise<DshSessionUsage | null> {
    // 大上下文回合收尾时，DSH 可能过一会儿才把最后一条 assistant/message
    // 落盘；等 2.5 秒而不是 0.4 秒，避免把这一轮统计成 0。
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const log = findDshSessionLog(this.options.dshHome, sessionId)
      if (log) {
        // 轮中每秒读一次时，日志没长就不要重新解压整份文件。
        let size = -1
        try { size = statSync(log).size } catch { size = -1 }
        if (size >= 0 && size === this.usageLogSize) {
          if (attempts > 1) { await new Promise((resolve) => setTimeout(resolve, 100)); continue }
          return null
        }
        if (size >= 0) this.usageLogSize = size
        const current = readDshSessionUsage(log)
        if (current.total > this.lastSessionUsage.total) {
          const delta = subtractUsage(current, this.lastSessionUsage)
          this.lastSessionUsage = current
          return delta
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return null
  }

  private async ensureSession(sdkSessionId?: string | null): Promise<string> {
    const generation = this.runtime.generation
    if (this.sessionId && this.sessionGeneration === generation) return this.sessionId
    const target = this.sessionId ?? sdkSessionId ?? null
    if (target) {
      try {
        const resumed = await this.runtime.resumeSession(target, this.options.cwd)
        this.sessionId = resumed.sessionId || target
        this.sessionGeneration = generation
        this.syncPlanMode(this.sessionId)
        return this.sessionId
      } catch {
        // A profile reset or a removed session: create a fresh one below.
      }
    }
    const created = await this.runtime.newSession(this.options.cwd)
    if (!created.sessionId) throw new Error('DSH ACP 没有返回会话 id。')
    this.sessionId = created.sessionId
    this.sessionGeneration = generation
    this.syncPlanMode(this.sessionId)
    return this.sessionId
  }

  /** 冷启动时如果停在计划模式，把状态补给刚建好的 DSH 会话。 */
  private syncPlanMode(sessionId: string): void {
    if (!this.planMode && this.approvalMode !== 'read-only') return
    void this.runtime.setPlan(sessionId, true).catch(() => undefined)
  }

  private async applySessionOptions(sessionId: string): Promise<void> {
    const effort = this.effort === 'max' ? 'high' : this.effort
    // 进程重建后同一个会话也要重新设置一次，所以把 generation 纳入 key。
    const key = `${sessionId}|${this.provider}|${this.model}|${effort}|${this.runtime.generation}`
    if (this.appliedOptionsKey === key) return
    const requested = JSON.stringify([this.provider, this.model])
    let configOptions: Array<Record<string, unknown>>
    try {
      const result = await this.runtime.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: requested
      }, 15_000) as { configOptions?: unknown }
      configOptions = Array.isArray(result?.configOptions)
        ? result.configOptions.map(objectValue) : []
    } catch (error) {
      throw new Error(`会话模型切换失败（${this.provider}/${this.model}）：${errorMessage(error)}`)
    }
    const modelOption = configOptions.find((option) => textValue(option.id) === 'model')
    const current = textValue(modelOption?.currentValue)
    if (current !== requested) {
      throw new Error(`DSH 没有接受模型设置：期望 ${this.provider}/${this.model}，当前 ${current || '未知'}。`)
    }
    // 推理档位只在模型确实声明时设置；界面的 off 对应 ACP 的 provider
    // default（空串）。目录里没有的档位不要硬塞，避免整轮失败。
    const reasoning = configOptions.find((option) => textValue(option.id) === 'reasoning_effort')
    if (reasoning !== undefined) {
      const values = Array.isArray(reasoning.options)
        ? reasoning.options.map(objectValue).map((option) => textValue(option.value))
        : []
      const desired = this.effort === 'off' ? '' : effort
      const value = values.includes(desired) ? desired
        : values.includes('') ? '' : undefined
      if (value !== undefined) {
        try {
          await this.runtime.request('session/set_config_option', {
            sessionId,
            configId: 'reasoning_effort',
            value
          }, 15_000)
        } catch (error) {
          throw new Error(`推理强度设置失败（${value || '默认'}）：${errorMessage(error)}`)
        }
      }
    }
    this.appliedOptionsKey = key
  }

  private decidePermission(kind: string): 'allow' | 'reject' | 'ask' {
    if (this.approvalMode === 'danger-full-access' || this.approvalMode === 'selfEvolve') return 'allow'
    // 计划模式只读：写操作直接拒绝，不打扰用户。
    if (this.planMode) return READ_ONLY_KINDS.has(kind) ? 'allow' : 'reject'
    // 手动审批（UI 第一档）逐条询问；沙箱仍是 workspace-write，批准后真的能写。
    if (this.approvalMode === 'read-only') return READ_ONLY_KINDS.has(kind) ? 'allow' : 'ask'
    // 工作区写入：沙箱已经限定范围，不再逐条弹窗。
    return 'allow'
  }

  private permissionForMode(mode: ApprovalMode): 'read-only' | 'workspace-write' | 'danger-full-access' {
    // “手动审批”要能批准写入，所以沙箱必须是 workspace-write；逐条询问由
    // decidePermission 负责。其余两档和 DSH 预设一一对应。
    if (mode === 'read-only') return 'workspace-write'
    if (mode === 'workspace-write') return 'workspace-write'
    return 'danger-full-access'
  }

  private async handleServerRequest(request: DshAcpServerRequest): Promise<unknown> {
    if (request.method === 'session/question') return this.askHostQuestion(request.params)
    if (request.method !== 'session/request_permission') {
      throw new Error(`未实现的 ACP 请求：${request.method}`)
    }
    const params = request.params
    const toolCall = objectValue(params.toolCall)
    const toolCallId = textValue(toolCall.toolCallId)
    const cached = toolCallId ? this.toolCallInfo.get(toolCallId) : undefined
    const options = Array.isArray(params.options) ? params.options.map(objectValue) : []
    const allow = options.find((option) => option.kind === 'allow_once' || option.optionId === 'allow-once')
    const reject = options.find((option) => option.kind === 'reject_once' || option.optionId === 'reject-once')
    const allowOptionId = textValue(allow?.optionId) || 'allow-once'
    const rejectOptionId = textValue(reject?.optionId) || 'reject-once'
    const toolName = textValue(toolCall.title) || cached?.title || '工具'
    const kind = effectiveToolKind(textValue(toolCall.kind), toolName)
    const decision = this.decidePermission(kind)
    if (decision === 'allow') return { outcome: { outcome: 'selected', optionId: allowOptionId } }
    if (decision === 'reject') return { outcome: { outcome: 'selected', optionId: rejectOptionId } }

    const listener = this.permissionListener
    const input = toolCall.rawInput === undefined
      ? (cached?.input ?? '')
      : JSON.stringify(toolCall.rawInput, null, 2)
    if (!listener) return { outcome: { outcome: 'selected', optionId: rejectOptionId } }
    const id = toolCallId || randomUUID()
    const requestForUser: ToolPermissionRequest = {
      id,
      tool: toolLabel(toolName),
      summary: `请求执行：${toolLabel(toolName)}`,
      input: input.length > MAX_PERMISSION_INPUT ? `${input.slice(0, MAX_PERMISSION_INPUT)}\n…（已截断）` : input
    }
    const optionId = await new Promise<string | null>((resolve) => {
      this.pendingPermissions.set(id, { resolve, allowOptionId, rejectOptionId })
      listener(requestForUser)
    })
    listener(null)
    if (!optionId) return { outcome: { outcome: 'cancelled' } }
    return { outcome: { outcome: 'selected', optionId } }
  }

  setApprovalMode(mode: ApprovalMode): boolean {
    this.approvalMode = mode
    // 不在这里关闭进程：DSH 的沙箱预设是进程级 env，下一次 respond()
    // 在真正发 prompt 前才需要换进程。切模式本身不应该打断/关闭当前进程。
    // 计划模式同时交给 DSH 的 planMode 服务：模型会拿到计划提示和
    // exit_plan_mode 工具，退出时的问题再经 session/question 回到面板。
    if (this.sessionId) {
      void this.runtime.setPlan(this.sessionId, mode === 'read-only').catch(() => undefined)
    }
    return true
  }

  setPlanMode(on: boolean): boolean {
    this.planMode = on
    if (this.sessionId) {
      void this.runtime.setPlan(this.sessionId, on).catch(() => undefined)
    }
    return true
  }

  setPermissionListener(listener: (request: ToolPermissionRequest | null) => void): void {
    this.permissionListener = listener
  }

  /** 子代理托盘的数据源；DSH 没有 task_started 事件，用子代理工具调用代替。 */
  setSubagentTasksListener(listener: (tasks: SubagentTask[]) => void): void {
    this.subagentListener = listener
  }

  setQuestionListener(listener: (question: AskQuestionRequest | null) => void): void {
    this.questionListener = listener
  }

  setPlanModeListener(listener: (on: boolean) => void): void {
    this.planModeListener = listener
  }

  setSteerEchoListener(listener: (messageId: string) => void): void {
    this.steerEchoListener = listener
  }

  /** 工具入参或服务请求里的 questions，统一成面板用的键。 */
  private parseQuestions(raw: unknown): AskQuestion[] {
    const list = Array.isArray(raw) ? raw : []
    return list.flatMap((item, index) => {
      const question = item && typeof item === 'object' ? item as Record<string, unknown> : {}
      const questionText = textValue(question.question)
      if (!questionText) return []
      const key = textValue(question.id) || questionText || `q${index}`
      const options = Array.isArray(question.options) ? question.options.flatMap((rawOption) => {
        const option = rawOption && typeof rawOption === 'object' ? rawOption as Record<string, unknown> : {}
        const label = textValue(option.label)
        if (!label) return []
        const description = textValue(option.description)
        return [{ label, ...(description ? { description } : {}) }]
      }) : []
      const header = textValue(question.header)
      const multiSelect = question.multiSelect === true || question.multi_select === true
      return [{ key, question: questionText, ...(header ? { header } : {}), options, multiSelect }]
    })
  }

  /** DSH 的提问工具：从入参解析出问题，交给已有的提问面板。
   *  如果服务级请求已经先到，工具调用只是同一条问题的重复通知，不再盖一张卡。 */
  private maybeStartQuestion(callId: string, title: string, rawInput: unknown): void {
    if (!isAskQuestionTool(title) || this.pendingHostQuestion) return
    const input = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
    const questions = this.parseQuestions(input.questions)
    if (!questions.length) return
    this.pendingAsk = { callId, request: { id: callId, questions } }
    this.questionListener?.({ id: callId, questions })
  }

  private clearQuestionTimer(): void {
    if (this.questionTimer) clearTimeout(this.questionTimer)
    this.questionTimer = undefined
  }

  /** 回答、停止或换问题时统一收尾：面板清空，等待中的 ACP 请求必须被拒绝，
   *  否则这一轮会永远停在“等回答”。 */
  private settleQuestions(reason: string): void {
    this.clearQuestionTimer()
    const host = this.pendingHostQuestion
    this.pendingHostQuestion = null
    this.pendingAsk = null
    if (host) host.reject(new Error(reason))
    this.questionListener?.(null)
  }

  /** 服务级提问（例如退出计划模式）：等面板回答后把答案直接交回服务。 */
  private askHostQuestion(params: Record<string, unknown>): Promise<unknown> {
    const questions = this.parseQuestions(params.questions)
    if (!questions.length) throw new Error('提问内容为空。')
    if (!this.questionListener) throw new Error('当前没有可用的提问面板。')
    // 工具调用先到时会挂着一张同内容的卡；复用它的 id，面板不闪第二遍。
    const duplicate = this.pendingAsk && sameQuestions(this.pendingAsk.request.questions, questions)
      ? this.pendingAsk : null
    // 同一个连接里不可能同时回答两个问题；新的问题覆盖旧的，旧请求明确失败。
    if (this.pendingHostQuestion) {
      const stale = this.pendingHostQuestion
      this.pendingHostQuestion = null
      stale.reject(new Error('新的提问替换了未回答的问题。'))
    }
    this.clearQuestionTimer()
    this.pendingAsk = null
    const id = duplicate?.callId ?? randomUUID()
    return new Promise((resolve, reject) => {
      this.pendingHostQuestion = { id, questions, resolve, reject }
      this.questionTimer = setTimeout(() => {
        if (this.pendingHostQuestion?.id !== id) return
        this.pendingHostQuestion = null
        this.pendingAsk = null
        this.questionTimer = undefined
        this.questionListener?.(null)
        reject(new Error('等待回答超时，问题已取消。'))
      }, QUESTION_TIMEOUT_MS)
      this.questionTimer.unref?.()
      if (!duplicate) this.questionListener?.({ id, questions })
    })
  }

  async answerQuestion(id: string, answers: AskAnswers | null): Promise<boolean> {
    const host = this.pendingHostQuestion
    if (host && host.id === id) {
      this.clearQuestionTimer()
      this.pendingHostQuestion = null
      this.questionListener?.(null)
      if (!answers) {
        host.reject(new Error('已取消回答。'))
        return true
      }
      const batch = answerBatch(host.questions, answers)
      if (batch.some((answer) => answer.selected.some((label) => /批准|同意|approve|approval/iu.test(label)))) {
        this.planModeListener?.(false)
      }
      host.resolve({ answers: batch })
      return true
    }
    const pending = this.pendingAsk
    if (!pending || pending.callId !== id) return false
    this.clearQuestionTimer()
    this.pendingAsk = null
    this.questionListener?.(null)
    if (!this.sessionId) return false
    try {
      return await this.runtime.answer(this.sessionId, id, answerBatch(pending.request.questions, answers))
    } catch {
      return false
    }
  }

  private startSubagentTask(id: string, title: string, rawInput: unknown): void {
    if (this.subagentTasks.has(id)) return
    const input = rawInput && typeof rawInput === 'object' ? rawInput as Record<string, unknown> : {}
    const raw = textValue(input.description) || textValue(input.prompt) || textValue(input.task) || title
    const description = raw.replace(/\s+/gu, ' ').trim().slice(0, 120) || title
    const task: SubagentTask = {
      taskId: id,
      toolUseId: id,
      description,
      subagentType: title,
      status: 'running',
      startedAt: new Date().toISOString(),
      timeline: []
    }
    this.subagentTasks.set(id, task)
    this.publishSubagentTasks()
  }

  private finishSubagentTask(id: string, failed: boolean, output: string): void {
    const task = this.subagentTasks.get(id)
    if (!task || task.status !== 'running') return
    task.status = failed ? 'failed' : 'completed'
    task.endedAt = new Date().toISOString()
    const started = task.startedAt ? Date.parse(task.startedAt) : NaN
    if (Number.isFinite(started)) task.durationMs = Math.max(0, Date.now() - started)
    if (output) task.summary = output.replace(/\s+/gu, ' ').trim().slice(0, 200)
    this.publishSubagentTasks()
  }

  private publishSubagentTasks(): void {
    this.subagentListener?.([...this.subagentTasks.values()].map((task) => structuredClone(task)))
  }

  /** 子会话的工具事件（ACP 补丁转发）：挂到对应托盘任务的步骤里。 */
  private handleSubagentEvent(params: Record<string, unknown>, sessionId: string): void {
    if (textValue(params.sessionId) !== sessionId) return
    const parentCallId = textValue(params.parentCallId)
    if (!parentCallId) return
    const task = this.subagentTasks.get(parentCallId)
    if (!task) return
    const phase = textValue(params.phase)
    const callId = textValue(params.callId) || randomUUID()
    const toolName = textValue(params.toolName) || '工具'
    const timeline = task.timeline ?? []
    if (phase === 'start') {
      timeline.push({
        id: callId,
        time: new Date().toISOString(),
        kind: 'tool',
        text: `${toolLabel(toolName)}（执行中）`,
        tool: {
          toolUseId: callId,
          name: toolName,
          status: 'running',
          ...(params.input === undefined ? {} : { input: JSON.stringify(params.input) })
        }
      })
      task.timeline = timeline.slice(-40)
      task.lastToolName = toolName
      this.publishSubagentTasks()
      return
    }
    const entry = timeline.find((item) => item.tool?.toolUseId === callId)
    if (!entry) return
    const failed = params.isError === true
    entry.tool = { ...entry.tool!, status: failed ? 'error' : 'done', output: toolEventOutput(params.output) }
    entry.text = `${toolLabel(toolName)}（${failed ? '失败' : '已完成'}）`
    task.timeline = timeline
    this.publishSubagentTasks()
  }

  /** 新一轮开始时清掉上一轮已经结束的子代理。 */
  private pruneFinishedSubagents(): void {
    let changed = false
    for (const [id, task] of this.subagentTasks) {
      if (task.status === 'running') continue
      this.subagentTasks.delete(id)
      changed = true
    }
    if (changed) this.publishSubagentTasks()
  }

  answerPermission(id: string, allow: boolean): boolean {
    const pending = this.pendingPermissions.get(id)
    if (!pending) return false
    this.pendingPermissions.delete(id)
    pending.resolve(allow ? pending.allowOptionId : pending.rejectOptionId)
    return true
  }

  setEffort(level: EffortLevel): void {
    this.effort = level
  }

  setWebSearchEnabled(on: boolean): void {
    if (this.webSearchEnabled === on) return
    this.webSearchEnabled = on
    this.bridge.webSearchEnabled = on
    // 写入 $DSH_HOME/cordis.patch.yml，禁用/恢复 tool-web；进程在下一轮重建，
    // 工具列表随之变化，模型不会先试一次再被拒。
    try {
      syncDshWebPatch(this.options.dshHome, on)
    } catch {
      // 写盘失败不阻断：提示词里也已经写明禁止联网。
    }
    this.restartForConfig()
  }

  /** 改了 profile 补丁（联网开关、压缩阈值）后，让下一轮重新拉起 DSH 进程；
   *  正在跑的回合不打断。 */
  private restartForConfig(): void {
    this.resetSession()
    if (this.busy) {
      this.pendingRestart = true
      return
    }
    this.applyPersona()
    void this.runtime.close().catch(() => undefined)
  }

  /** 供应商地址变了：进程环境必须重建，但会话不重置——下一轮用同一个
   *  session id 续接，切换模型不该丢上下文。 */
  private restartForProvider(): void {
    if (this.busy) {
      this.pendingProviderRestart = true
      return
    }
    void this.runtime.close().catch(() => undefined)
  }

  setAutoCompactPercent(percent: number): void {
    if (this.autoCompactPercent === percent) return
    this.autoCompactPercent = percent
    try {
      syncDshCompactPatch(this.options.dshHome, percent)
    } catch {
      // 写盘失败不阻断；DSH 仍按它自己的默认阈值压缩。
    }
    this.restartForConfig()
  }

  setLibraries(servers: Record<string, unknown>, plugins: string[]): void {
    if (this.options.libraries) {
      this.options.libraries.mcp = servers
      this.options.libraries.plugins = plugins
    }
    // DSH discovers skills under DSH_HOME/skills; copy the library's skill
    // bundles there before the next session so they appear in its catalog.
    syncDshSkills(this.options.dshHome, plugins)
    // MCP declarations are fixed at session/new, so the next turn starts a
    // session that sees the updated set.
    this.resetSession()
  }

  setPersonaId(id: string): void {
    if (this.personaId === id) return
    this.personaId = id
    // The process persona is fixed at spawn time; the old transcript carries
    // the old prompt, so the next turn starts from a fresh DSH session.
    this.resetSession()
    this.applyPersona()
  }

  private resetSession(): void {
    this.sessionId = null
    this.sessionGeneration = -1
    this.appliedOptionsKey = ''
    this.lastContextUsage = { status: 'unavailable' }
    this.lastSessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    this.usageLogSize = -1
  }

  setOutputStyle(style?: string): void {
    const next = style?.trim() ?? ''
    if (this.outputStyle === next) return
    this.outputStyle = next
    this.restartForConfig()
  }

  setAppendSystemPrompt(text?: string): void {
    const next = text?.trim() ?? ''
    if (this.appendSystemPrompt === next) return
    this.appendSystemPrompt = next
    this.restartForConfig()
  }

  setLoadUserSettings(_on: boolean): void {}

  setProvider(provider?: { baseUrl: string; apiKey: string; model: string; smallModel?: string; extraEnv?: string }): void {
    if (provider?.model) this.model = normalizeDshModel(provider.model)
    if (provider) {
      const baseUrl = provider.baseUrl?.trim() ?? ''
      const changed = baseUrl !== this.providerBaseUrl
      this.providerBaseUrl = baseUrl
      this.runtime.setDeepSeekEnvironment?.({ apiKey: provider.apiKey, baseUrl })
      this.bridge.setDeepSeekApiKey(resolveDeepSeekToolsKey(provider))
      if (changed) this.restartForProvider()
    }
  }

  setIdentity(identity?: { userName?: string; assistantName?: string }): void {
    const next = identity ?? {}
    if (next.userName === this.identity.userName && next.assistantName === this.identity.assistantName) return
    this.identity = next
    this.resetSession()
    this.applyPersona()
  }

  setConversationBridge(bridge?: ConversationBridge): void {
    this.bridge.setConversationBridge(bridge)
  }

  setEvolveBridge(bridge?: EvolveBridge): void {
    this.bridge.setEvolveBridge(bridge)
  }

  /** 图片输入能力：undefined = 还没握手，不知道；false = 模型不支持。 */
  imageInputSupport(): boolean | undefined {
    if (!this.sessionId) return undefined
    return this.runtime.supportsImagePrompts
  }

  /** 当前 DSH 会话 id；用户中途停止时宿主用它把会话记下来，下一条才能续上。 */
  currentSessionId(): string | null {
    return this.sessionId
  }

  private contextUsageFrom(used: number, size: number): ContextUsageSnapshot {
    return {
      status: 'available',
      usedTokens: used,
      maxTokens: size,
      usedPercent: size > 0 ? Math.round((used / size) * 1000) / 10 : undefined,
      remainingTokens: Math.max(0, size - used),
      remainingPercent: size > 0 ? Math.round(((size - used) / size) * 1000) / 10 : undefined,
      checkedAt: new Date().toISOString()
    }
  }

  /** 主动读一次 DSH 的实时占用。压缩后必须走这里，不能沿用压缩前的缓存读数。 */
  private async readContextUsage(): Promise<ContextUsageSnapshot> {
    const sessionId = this.sessionId
    if (!sessionId) return { ...this.lastContextUsage }
    try {
      const usage = await this.runtime.usage(sessionId)
      if (sessionId !== this.sessionId) return { ...this.lastContextUsage }
      if (typeof usage?.used === 'number' && typeof usage?.size === 'number') {
        this.lastContextUsage = this.contextUsageFrom(usage.used, usage.size)
      }
    } catch {
      // 未打补丁的运行时没有 session/usage：退回最近一次推送的读数。
    }
    return { ...this.lastContextUsage }
  }

  getContextUsage(): Promise<ContextUsageSnapshot> {
    return this.readContextUsage()
  }

  /** 手动压缩：调用我们补的 session/compact；没有可压缩内容时如实返回未压缩。 */
  async compact(_sessionId?: string | null): Promise<ContextUsageSnapshot> {
    if (!this.sessionId) throw new Error('还没有可压缩的会话。')
    let result: { shadowed?: number; tokens?: number } | undefined
    let firstError: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        result = await this.runtime.compact(this.sessionId)
        firstError = undefined
        break
      } catch (error) {
        firstError = error
        // 摘要模型偶尔只回 reasoning 或空正文；再给一次机会，换一个请求。
        if (attempt === 0) await new Promise<void>((resolve) => setTimeout(resolve, 400))
      }
    }
    if (firstError) {
      console.warn('DSH compact failed:', firstError instanceof Error ? firstError.message : String(firstError))
      throw new Error('上下文压缩暂时失败：摘要模型这次没有返回正文。已保留原上下文，请稍后重试。')
    }
    // 压缩完成立刻刷新：面板这一帧就显示压缩后的占用，而不是等下一轮。
    const usage = await this.readContextUsage()
    const compacted = typeof result?.shadowed === 'number' && result.shadowed > 0
    return { ...usage, compactionOutcome: compacted ? 'compacted' : 'not_needed' }
  }

  /** 原生插队：修补后的 DSH 支持 session/steer，把消息插到当前回合的下一步。
   *  返回投递结果；请求本身失败时让异常冒泡，宿主按“无法确认”处理。 */
  async steer(rawText: string): Promise<{ accepted: boolean; messageId?: string }> {
    const text = rawText.trim()
    if (!text || !this.busy || !this.sessionId) return { accepted: false }
    const result = await this.runtime.steer(this.sessionId, [{ type: 'text', text }])
    return {
      accepted: result.queued,
      ...(result.messageId === void 0 ? {} : { messageId: result.messageId })
    }
  }

  async interrupt(): Promise<void> {
    // 先清掉等待面板的问题：停止后它已经没有意义，不能让面板继续挂着。
    this.settleQuestions('本轮已停止，问题已取消。')
    for (const pending of this.pendingPermissions.values()) pending.resolve(null)
    this.pendingPermissions.clear()
    this.permissionListener?.(null)
    if (this.sessionId) await this.runtime.cancel(this.sessionId)
  }

  async dispose(): Promise<void> {
    this.settleQuestions('运行时已关闭，问题已取消。')
    await this.runtime.close().catch(() => undefined)
    await this.bridge.close().catch(() => undefined)
  }
}
