import { randomUUID } from 'node:crypto'
import type {
  AskAnswers, ContextUsageSnapshot, ConversationLibraryState, ConversationSettings, ConversationSummary, ModelMode,
  PendingMessage, SideChatSnapshot, TaskStatus, UserAttachment
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
  if (typeof text !== 'string' || !validAttachmentList(attachments)) throw new Error('临时会话消息无效。')
  const clean = text.trim()
  const prompt = [clean, attachmentContext(attachments)].filter(Boolean).join('\n\n')
  if (!prompt || prompt.length > 8_000) throw new Error('消息不能为空，且单条消息最多 8000 字。')
  const slash = parseAppSlashCommand(clean)
  if (slash || /^\/goal(?:\s|$)/iu.test(clean)) {
    if (attachments.length) throw new Error('应用命令不能附带文件。')
    if (slash?.name === 'side' || slash?.name === 'btw') throw new Error('已经在临时会话中。')
    throw new Error(`/${slash?.name ?? 'goal'} 仅适用于主会话。`)
  }
  if (mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
    throw new Error('当前模型没有本地文件读取工具，请切换到小鲸引擎模式。')
  }
  return clean
}

/** One optional in-memory child per main conversation. Switching tabs keeps
 * each child's queue and SDK query alive; removing its parent releases it. */
export class SideChatController {
  private readonly sides = new Map<string, ActiveSideChat>()
  private readonly publishedStatuses = new Map<string, TaskStatus>()

  constructor(
    private readonly createRuntime: (onChange: () => void, persistSession?: boolean) => AgentRuntime,
    private readonly source: () => SideChatSource,
    private readonly memoryContext: () => Promise<string>,
    private readonly onChange: () => void = () => {},
    private readonly onError: (error: unknown) => void = () => {},
    private readonly currentParentId: () => string | null = () => source().parentConversationId,
    private readonly currentSettings: () => ConversationSettings = () => source().settings,
    private readonly onStatusChange: () => void = () => {}
  ) {}

  private currentSide(): ActiveSideChat | null {
    const parentId = this.currentParentId()
    return parentId ? this.sides.get(parentId) ?? null : null
  }

  private owns(side: ActiveSideChat): boolean {
    return this.sides.get(side.parentConversationId) === side
  }

  private changed(side?: ActiveSideChat): void {
    if (!side || this.currentParentId() === side.parentConversationId) this.onChange()
    if (side) {
      const before = this.publishedStatuses.get(side.parentConversationId) ?? null
      const after = this.statusForParent(side.parentConversationId)
      if (after) this.publishedStatuses.set(side.parentConversationId, after)
      else this.publishedStatuses.delete(side.parentConversationId)
      if (before !== after) this.onStatusChange()
    }
  }

  private require(sessionId: string): ActiveSideChat {
    const side = this.currentSide()
    if (!side || side.sessionId !== sessionId) {
      throw new Error('临时会话已关闭或主会话已切换。')
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
    const parentConversationId = this.currentParentId()
    const side = this.currentSide()
    if (!side) return { sessionId: null, parentConversationId, expanded: false, queuePaused: false, snapshot: null, pendingMessages: [] }
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
    const existing = this.sides.get(parent.parentConversationId)
    if (existing) {
      existing.expanded = true
      this.changed(existing)
      return this.getSnapshot()
    }
    const sessionId = randomUUID()
    const runtime = this.createRuntime(() => {
      const side = this.sides.get(parent.parentConversationId!)
      if (!side || side.sessionId !== sessionId) return
      this.changed(side)
      this.scheduleDrain(side)
    }, false)
    runtime.conversationId = sessionId
    runtime.seedHistory(parent.history)
    this.configure(runtime, parent.settings)
    runtime.setModelMode(parent.mode, true)
    const side: ActiveSideChat = {
      sessionId, parentConversationId: parent.parentConversationId,
      runtime, expanded: true, pending: [], draining: null, steeringQueued: false, generation: 0, paused: false
    }
    this.sides.set(parent.parentConversationId, side)
    this.changed(side)
    return this.getSnapshot()
  }

  /** The slash command is one operation: invalid input never opens a child;
   * a later send failure restores the prior folded state or drops a new one. */
  async openWithMessage(text: string, attachments: UserAttachment[] = []): Promise<SideChatSnapshot> {
    validateSideChatMessage(text, attachments, this.source().mode)
    const priorSide = this.currentSide()
    const previous = priorSide && { sessionId: priorSide.sessionId, expanded: priorSide.expanded }
    const opened = this.open()
    try {
      await this.send(opened.sessionId!, text, attachments)
      return this.getSnapshot()
    } catch (error) {
      const side = opened.parentConversationId ? this.sides.get(opened.parentConversationId) : null
      if (side?.sessionId === opened.sessionId) {
        if (previous?.sessionId === opened.sessionId) {
          side.expanded = previous.expanded
          this.changed(side)
        } else await this.discardParent(side.parentConversationId)
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
    const side = this.currentSide()
    if (sessionId && side?.sessionId !== sessionId) return
    if (!side) return
    await this.discardParent(side.parentConversationId)
  }

  /** Owner lifecycle operations may release an offscreen child. UI requests
   * always go through discard(sessionId), which only addresses the shown tab. */
  async discardParent(parentConversationId: string): Promise<void> {
    const side = this.sides.get(parentConversationId)
    if (!side) return
    this.sides.delete(parentConversationId)
    side.generation += 1
    side.pending.length = 0
    side.runtime.stop()
    this.changed(side)
    try { await side.runtime.dispose() } catch (error) { this.onError(error) }
  }

  async discardAll(): Promise<void> {
    await Promise.all([...this.sides.keys()].map((id) => this.discardParent(id)))
  }

  /** Auto-archive and library reload can remove non-displayed owners. Stop
   * them synchronously before allowing another queued drain to start. */
  discardMissingParents(parentIds: ReadonlySet<string>): void {
    for (const id of [...this.sides.keys()]) {
      if (!parentIds.has(id)) void this.discardParent(id).catch(this.onError)
    }
  }

  isBusyForParent(parentConversationId: string): boolean {
    const side = this.sides.get(parentConversationId)
    return Boolean(side && (side.runtime.isRunning() || side.draining || side.steeringQueued || side.pending.length))
  }

  isBusy(): boolean {
    return [...this.sides.keys()].some((id) => this.isBusyForParent(id))
  }

  /** A quiet main tab can still show its child working in the tab status dot. */
  statusForParent(parentConversationId: string): TaskStatus | null {
    const side = this.sides.get(parentConversationId)
    if (!side || !this.isBusyForParent(parentConversationId)) return null
    const snapshot = side.runtime.getSnapshot()
    if (snapshot.proposal || snapshot.taskStatus === 'awaiting_approval' || side.paused) return 'awaiting_approval'
    return ['planning', 'executing', 'verifying'].includes(snapshot.taskStatus)
      ? snapshot.taskStatus : 'planning'
  }

  /** Use the same status projection in quick tabs and library search rows.
   * Active main work retains priority over side work. */
  withSideStatuses(summaries: ConversationSummary[]): ConversationSummary[] {
    return summaries.map((summary) => {
      const status = this.statusForParent(summary.id)
      return status && !['planning', 'awaiting_approval', 'executing', 'verifying'].includes(summary.taskStatus)
        ? { ...summary, taskStatus: status } : summary
    })
  }

  private scheduleDrain(side: ActiveSideChat): void {
    if (!this.owns(side) || side.paused || side.draining || side.steeringQueued || side.runtime.isRunning() || !side.pending.length) return
    const generation = side.generation
    const work = Promise.resolve().then(async () => {
      while (this.owns(side) && generation === side.generation && !side.paused &&
             !side.runtime.isRunning() && side.pending.length) {
        const next = side.pending.shift()!
        this.changed(side)
        if (!this.owns(side) || generation !== side.generation) return
        this.configure(side.runtime, this.currentSettings())
        await side.runtime.sendMessage(next.text, next.attachments)
      }
    })
    side.draining = work
    void work.catch(this.onError).finally(() => {
      if (side.draining === work) side.draining = null
      if (this.owns(side)) {
        this.changed(side)
        this.scheduleDrain(side)
      }
    })
  }

  async send(sessionId: string, text: string, attachments: UserAttachment[] = [], strategy: 'queue' | 'steer' = 'queue'): Promise<void> {
    const side = this.require(sessionId)
    if (strategy !== 'queue' && strategy !== 'steer') throw new Error('临时会话消息无效。')
    const clean = validateSideChatMessage(text, attachments, side.runtime.getSnapshot().mode)
    const generation = side.generation
    const wasPaused = side.paused
    if (strategy === 'steer' && await side.runtime.steerMessage(clean, attachments)) {
      if (!this.owns(side) || generation !== side.generation) throw new Error('临时会话已停止或关闭。')
      this.changed(side)
      return
    }
    if (!this.owns(side) || generation !== side.generation) throw new Error('临时会话已停止或关闭。')
    if (wasPaused) side.paused = false
    const message: PendingMessage = { id: randomUUID(), text: clean, attachments: structuredClone(attachments), createdAt: new Date().toISOString() }
    if (wasPaused || strategy === 'steer') side.pending.unshift(message)
    else side.pending.push(message)
    this.changed(side)
    this.scheduleDrain(side)
  }

  stop(sessionId: string): void {
    const side = this.require(sessionId)
    side.generation += 1
    side.paused = true
    side.runtime.stop()
    this.changed(side)
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.require(sessionId).runtime.interruptTurn()
  }

  removeQueued(sessionId: string, messageId: string): void {
    const side = this.require(sessionId)
    const index = side.pending.findIndex((message) => message.id === messageId)
    if (index < 0) throw new Error('找不到这条待发送消息。')
    side.pending.splice(index, 1)
    this.changed(side)
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
    this.changed(side)
    let steered = false
    try { steered = await side.runtime.steerMessage(message.text, message.attachments) }
    catch (error) {
      if (this.owns(side)) {
        side.pending.unshift(message)
        this.changed(side)
        queueMicrotask(() => this.scheduleDrain(side))
      }
      throw error
    } finally {
      side.steeringQueued = false
    }
    if (!this.owns(side)) return
    // stop() changes the epoch. A steer accepted before stop stays consumed;
    // one that lost the race returns to the paused queue.
    if (generation !== side.generation) {
      if (!steered) side.pending.unshift(message)
      this.changed(side)
      return
    }
    if (!steered) side.pending.unshift(message)
    this.changed(side)
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
    if (side.pending.length || side.draining) throw new Error('请等待临时会话的待发送消息完成后再压缩。')
    await side.runtime.compactConversation()
  }
  setModelMode(sessionId: string, mode: ModelMode): void {
    const side = this.require(sessionId)
    if (side.pending.length || side.draining) throw new Error('待发送消息未处理完，不能切换模型。')
    side.runtime.setModelMode(mode)
  }
  async setPlanMode(sessionId: string, on: boolean): Promise<void> { await this.require(sessionId).runtime.setPlanMode(on) }
}
