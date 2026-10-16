import { randomUUID } from 'node:crypto'
import type {
  AskAnswers, ContextUsageSnapshot, ConversationLibraryState, ConversationSettings, ModelMode,
  PendingMessage, SideChatSnapshot, UserAttachment
} from '../shared/contracts'
import type { DialogueLine } from './deepseek'
import type { AgentRuntime } from './agent-runtime'
import { attachmentContext, validAttachmentList } from './local-context'
import { parseAppSlashCommand } from './claude-workflows'

export interface SideChatSource {
  parentConversationId: string | null
  mode: ModelMode
  settings: ConversationSettings
  history: DialogueLine[]
}

/** `displayedConversationId` can remain stale after the last tab is closed.
 * A child may only attach to the library's currently active, visible record. */
export function activeSideChatParentId(
  displayedId: string | null,
  library: Pick<ConversationLibraryState, 'activeConversationId' | 'conversations'>
): string | null {
  if (!displayedId || library.activeConversationId !== displayedId) return null
  return library.conversations.some((record) => record.id === displayedId && record.archivedAt === null)
    ? displayedId : null
}

interface ActiveSideChat {
  sessionId: string
  parentConversationId: string
  runtime: AgentRuntime
  expanded: boolean
  pending: PendingMessage[]
  draining: Promise<void> | null
  steeringQueued: boolean
  generation: number
  paused: boolean
}

/** Validate before creating a child so a rejected /side command leaves the
 * existing child and the main composer untouched. */
export function validateSideChatMessage(text: string, attachments: UserAttachment[], mode: ModelMode): string {
  if (typeof text !== 'string' || !validAttachmentList(attachments)) throw new Error('临时侧聊消息无效。')
  const clean = text.trim()
  const prompt = [clean, attachmentContext(attachments)].filter(Boolean).join('\n\n')
  if (!prompt || prompt.length > 8_000) throw new Error('消息不能为空，且单条消息最多 8000 字。')
  const slash = parseAppSlashCommand(clean)
  if (slash || /^\/goal(?:\s|$)/iu.test(clean)) {
    if (attachments.length) throw new Error('应用命令不能附带文件。')
    if (slash?.name === 'side' || slash?.name === 'btw') throw new Error('已经在临时侧聊中。')
    throw new Error(`/${slash?.name ?? 'goal'} 仅适用于主会话。`)
  }
  if (mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
    throw new Error('当前模型没有本地文件读取工具，请切换到 Claude Code 模式。')
  }
  return clean
}

/** One optional child of the displayed conversation. Nothing in this class
 * touches ConversationStore: queue, source history and SDK session live only
 * for the process lifetime and vanish on parent switch or discard. */
export class SideChatController {
  private active: ActiveSideChat | null = null

  constructor(
    private readonly createRuntime: (onChange: () => void, persistSession?: boolean) => AgentRuntime,
    private readonly source: () => SideChatSource,
    private readonly memoryContext: () => Promise<string>,
    private readonly onChange: () => void = () => {},
    private readonly onError: (error: unknown) => void = () => {},
    private readonly currentParentId: () => string | null = () => source().parentConversationId,
    private readonly currentSettings: () => ConversationSettings = () => source().settings
  ) {}

  private changed(): void { this.onChange() }

  private require(sessionId: string): ActiveSideChat {
    const side = this.active
    if (!side || side.sessionId !== sessionId ||
        this.currentParentId() !== side.parentConversationId) {
      throw new Error('临时侧聊已关闭或主会话已切换。')
    }
    return side
  }

  private configure(runtime: AgentRuntime, settings: ConversationSettings): void {
    const profile = settings.modelProfiles.find((item) => item.id === settings.activeModelProfileId) ?? null
    runtime.setModelProfile(profile)
    runtime.setIdentity({ userName: settings.userName, assistantName: settings.assistantName })
    runtime.setEffort(settings.effort)
    runtime.setGoalBudget(settings.goalMaxIterations, settings.goalMaxMinutes)
    runtime.setMemoryContextProvider(this.memoryContext)
  }

  private visiblePending(side: ActiveSideChat): PendingMessage[] {
    // The composer uses this copy when editing a queued message. Keep the
    // user's inline file text so a resend remains valid in live mode.
    return structuredClone(side.pending)
  }

  /** Full snapshots returned to IPC callers never consume the delta cursor. */
  getSnapshot(): SideChatSnapshot {
    const side = this.active
    if (side && this.currentParentId() !== side.parentConversationId) {
      void this.discard()
      return { sessionId: null, parentConversationId: null, expanded: false, queuePaused: false, snapshot: null, pendingMessages: [] }
    }
    if (!side) return { sessionId: null, parentConversationId: null, expanded: false, queuePaused: false, snapshot: null, pendingMessages: [] }
    return {
      sessionId: side.sessionId,
      parentConversationId: side.parentConversationId,
      expanded: side.expanded,
      queuePaused: side.paused,
      ...(side.paused ? { pauseReason: '任务已停止；待发送消息仍保留，发送新消息可继续。' } : {}),
      snapshot: structuredClone(side.runtime.getSnapshot()),
      pendingMessages: this.visiblePending(side)
    }
  }

  /** Temporary histories are short. Publish full snapshots so a late or
   * reordered side event cannot erase earlier rows in the renderer. */
  takePublishSnapshot(): SideChatSnapshot {
    return this.getSnapshot()
  }

  open(): SideChatSnapshot {
    const parent = this.source()
    if (!parent.parentConversationId) throw new Error('请先打开一个主会话。')
    if (parent.parentConversationId !== this.currentParentId()) throw new Error('主会话已切换，请重新发送。')
    if (this.active?.parentConversationId === parent.parentConversationId) {
      this.active.expanded = true
      this.changed()
      return this.getSnapshot()
    }
    if (this.active) void this.discard().catch(this.onError)
    const sessionId = randomUUID()
    const runtime = this.createRuntime(() => {
      if (this.active?.sessionId !== sessionId) return
      this.changed()
      this.scheduleDrain(this.active)
    }, false)
    runtime.conversationId = sessionId
    runtime.seedHistory(parent.history)
    this.configure(runtime, parent.settings)
    runtime.setModelMode(parent.mode, true)
    this.active = {
      sessionId, parentConversationId: parent.parentConversationId,
      runtime, expanded: true, pending: [], draining: null, steeringQueued: false, generation: 0, paused: false
    }
    this.changed()
    return this.getSnapshot()
  }

  /** The slash command is one operation: invalid input never opens a child;
   * a later send failure restores the prior folded state or drops a new one. */
  async openWithMessage(text: string, attachments: UserAttachment[] = []): Promise<SideChatSnapshot> {
    validateSideChatMessage(text, attachments, this.source().mode)
    const previous = this.active && { sessionId: this.active.sessionId, expanded: this.active.expanded }
    const opened = this.open()
    try {
      await this.send(opened.sessionId!, text, attachments)
      return this.getSnapshot()
    } catch (error) {
      if (this.active?.sessionId === opened.sessionId) {
        if (previous?.sessionId === opened.sessionId) {
          this.active.expanded = previous.expanded
          this.changed()
        } else await this.discard()
      }
      throw error
    }
  }

  setExpanded(sessionId: string, expanded: boolean): SideChatSnapshot {
    const side = this.require(sessionId)
    side.expanded = expanded
    this.changed()
    return this.getSnapshot()
  }

  async discard(sessionId?: string): Promise<void> {
    const side = this.active
    if (sessionId && side?.sessionId !== sessionId) return
    if (!side) return
    this.active = null
    side.generation += 1
    side.pending.length = 0
    side.runtime.stop()
    this.changed()
    try { await side.runtime.dispose() } catch (error) { this.onError(error) }
  }

  isBusy(): boolean {
    const side = this.active
    return Boolean(side && (side.runtime.isRunning() || side.draining || side.steeringQueued || side.pending.length))
  }

  private scheduleDrain(side: ActiveSideChat): void {
    if (this.active !== side || side.paused || side.draining || side.steeringQueued || side.runtime.isRunning() || !side.pending.length) return
    const generation = side.generation
    const work = Promise.resolve().then(async () => {
      while (this.active === side && generation === side.generation && !side.paused &&
             !side.runtime.isRunning() && side.pending.length) {
        const next = side.pending.shift()!
        this.changed()
        if (this.active !== side || generation !== side.generation) return
        this.configure(side.runtime, this.currentSettings())
        await side.runtime.sendMessage(next.text, next.attachments)
      }
    })
    side.draining = work
    void work.catch(this.onError).finally(() => {
      if (side.draining === work) side.draining = null
      if (this.active === side) {
        this.changed()
        this.scheduleDrain(side)
      }
    })
  }

  async send(sessionId: string, text: string, attachments: UserAttachment[] = [], strategy: 'queue' | 'steer' = 'queue'): Promise<void> {
    const side = this.require(sessionId)
    if (strategy !== 'queue' && strategy !== 'steer') throw new Error('临时侧聊消息无效。')
    const clean = validateSideChatMessage(text, attachments, side.runtime.getSnapshot().mode)
    const generation = side.generation
    const wasPaused = side.paused
    if (strategy === 'steer' && await side.runtime.steerMessage(clean, attachments)) {
      if (this.active !== side || generation !== side.generation) throw new Error('临时侧聊已停止或关闭。')
      this.changed()
      return
    }
    if (this.active !== side || generation !== side.generation) throw new Error('临时侧聊已停止或关闭。')
    if (wasPaused) side.paused = false
    const message: PendingMessage = { id: randomUUID(), text: clean, attachments: structuredClone(attachments), createdAt: new Date().toISOString() }
    if (wasPaused || strategy === 'steer') side.pending.unshift(message)
    else side.pending.push(message)
    this.changed()
    this.scheduleDrain(side)
  }

  stop(sessionId: string): void {
    const side = this.require(sessionId)
    side.generation += 1
    side.paused = true
    side.runtime.stop()
    this.changed()
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.require(sessionId).runtime.interruptTurn()
  }

  removeQueued(sessionId: string, messageId: string): void {
    const side = this.require(sessionId)
    const index = side.pending.findIndex((message) => message.id === messageId)
    if (index < 0) throw new Error('找不到这条待发送消息。')
    side.pending.splice(index, 1)
    this.changed()
  }

  async steerQueued(sessionId: string, messageId: string): Promise<void> {
    const side = this.require(sessionId)
    if (side.steeringQueued) throw new Error('另一条待发送消息正在转向。')
    const index = side.pending.findIndex((message) => message.id === messageId)
    if (index < 0) throw new Error('找不到这条待发送消息。')
    const generation = side.generation
    side.steeringQueued = true
    // Claim the exact item before awaiting the SDK. A simultaneous remove or
    // drain must not make a later splice delete somebody else's message.
    const [message] = side.pending.splice(index, 1)
    this.changed()
    let steered = false
    try { steered = await side.runtime.steerMessage(message.text, message.attachments) }
    catch (error) {
      if (this.active === side) {
        side.pending.unshift(message)
        this.changed()
        queueMicrotask(() => this.scheduleDrain(side))
      }
      throw error
    } finally {
      side.steeringQueued = false
    }
    if (this.active !== side) return
    // stop() changes the epoch. A steer accepted before stop stays consumed;
    // one that lost the race returns to the paused queue.
    if (generation !== side.generation) {
      if (!steered) side.pending.unshift(message)
      this.changed()
      return
    }
    if (!steered) side.pending.unshift(message)
    this.changed()
    this.scheduleDrain(side)
  }

  async approveAction(sessionId: string, id: string): Promise<void> { await this.require(sessionId).runtime.approveAction(id) }
  rejectAction(sessionId: string, id: string): void { this.require(sessionId).runtime.rejectAction(id) }
  async answerQuestion(sessionId: string, id: string, answers: AskAnswers | null): Promise<void> {
    await this.require(sessionId).runtime.answerQuestion(id, answers)
  }
  async answerPlan(sessionId: string, id: string, approved: boolean): Promise<void> {
    await this.require(sessionId).runtime.answerPlan(id, approved)
  }
  async getContextUsage(sessionId: string): Promise<ContextUsageSnapshot> {
    return this.require(sessionId).runtime.getContextUsage()
  }
  async compact(sessionId: string): Promise<void> {
    const side = this.require(sessionId)
    if (side.pending.length || side.draining) throw new Error('请等待临时侧聊的待发送消息完成后再压缩。')
    await side.runtime.compactConversation()
  }
  setModelMode(sessionId: string, mode: ModelMode): void {
    const side = this.require(sessionId)
    if (side.pending.length || side.draining) throw new Error('待发送消息未处理完，不能切换模型。')
    side.runtime.setModelMode(mode)
  }
  async setPlanMode(sessionId: string, on: boolean): Promise<void> { await this.require(sessionId).runtime.setPlanMode(on) }
}
