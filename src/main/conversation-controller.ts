import { randomUUID } from 'node:crypto'
import type { AppSnapshot, AskAnswers, ContextUsageSnapshot, ConversationBatchAction, ConversationBatchResult, ModelMode, ModelProfile, TimelineEntry, UserAttachment } from '../shared/contracts'
import { deleteTurnEntries, type AgentRuntime } from './agent-runtime'
import { attachmentContext, validAttachmentList } from './local-context'
import { snapshotSessionMentions } from './session-context'
import {
  ConversationStore,
  ConversationStoreError,
  type ConversationLibraryState,
  type ConversationRecord,
  type ConversationSearchOptions,
  type ConversationSettings,
  type ConversationSummary,
  type PendingMessage
} from './conversation-store'

export type SendStrategy = 'queue' | 'steer'

export interface CompletedTurn {
  conversationId: string
  userText: string
  finalReply: string
  mode: ModelMode
  timeline: TimelineEntry[]
}

export interface ConversationTurnHooks {
  memoryContext?: () => Promise<string>
  afterSuccessfulTurn?: (turn: CompletedTurn) => Promise<void>
}

export type ControllerSnapshot = AppSnapshot & {
  conversationLibrary: ConversationLibraryState
  pendingMessages: PendingMessage[]
}

function validateMessage(text: string, attachments: UserAttachment[]): string {
  if (typeof text !== 'string' || !validAttachmentList(attachments)) {
    throw new ConversationStoreError('INVALID_INPUT', '消息格式无效。')
  }
  const clean = text.trim()
  const prompt = [clean, attachmentContext(attachments)].filter(Boolean).join('\n\n')
  if (!prompt || prompt.length > 8_000) {
    throw new ConversationStoreError('INVALID_INPUT', '消息不能为空，且单条消息最多 8000 字。')
  }
  return clean
}

/** The renderer needs the queue controls, never another conversation's frozen
 * source text that was captured for a model request. */
function visiblePending(message: PendingMessage): PendingMessage {
  const { sessionContext: _context, ...visible } = message
  return structuredClone(visible)
}

/**
 * Keeps one AgentRuntime per conversation that has actually run, plus the
 * queue and drain state of each. `activeId` is the *displayed* conversation —
 * switching it never touches a runtime, so any number of conversations can be
 * working in parallel while the panel shows whichever one the user picked.
 */
export class ConversationController {
  private initialized = false
  private initialization: Promise<void> | null = null
  private library: ConversationLibraryState | null = null
  /** The displayed conversation — what every snapshot describes. */
  private activeId: string | null = null
  /** One live runtime per conversation that has sent or been restored. */
  private readonly runtimes = new Map<string, AgentRuntime>()
  /** Queue + drain bookkeeping, per conversation. */
  private readonly pending = new Map<string, PendingMessage[]>()
  private readonly drains = new Map<string, { promise: Promise<void>; generation: number }>()
  private readonly drainGenerations = new Map<string, number>()
  /** Explicit stop and goal budget pauses retain the pending queue on disk. */
  private readonly pausedQueues = new Map<string, string>()
  /** A displayed conversation without a runtime is served from this record. */
  private displayedRecord: ConversationRecord | null = null
  private operations: Promise<void> = Promise.resolve()
  /** Last seen readiness flags — a cold snapshot still has to answer them. */
  private readiness = { modelReady: false, claudeCodeReady: false }
  private turnHooks: ConversationTurnHooks = {}

  constructor(
    private readonly store: ConversationStore,
    private readonly createRuntime: (onChange: () => void) => AgentRuntime,
    private readonly onChange: () => void = () => {},
    private readonly onBackgroundError: (error: unknown) => void = () => {},
    private readonly generateTitle?: (source: string) => Promise<string | null>,
    /** Materialized on first load when no profile exists yet — the launch
     *  environment's own setup, so the model menu never starts empty. */
    private readonly seedProfile?: ModelProfile
  ) {}

  setTurnHooks(hooks: ConversationTurnHooks): void {
    this.turnHooks = hooks
    for (const runtime of this.runtimes.values()) runtime.setMemoryContextProvider(hooks.memoryContext)
  }

  allConversationsIdle(): boolean {
    return this.drains.size === 0 && [...this.runtimes.values()].every((runtime) => !runtime.isRunning()) &&
      [...this.pending.values()].every((queue) => queue.length === 0)
  }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.load().catch((error: unknown) => {
        this.initialization = null
        throw error
      })
    }
    return this.initialization
  }

  private async load(): Promise<void> {
    await this.store.initialize()
    await this.store.archiveInactiveConversations()
    let state = await this.store.getState()
    let record = state.activeConversationId ? await this.store.getConversation(state.activeConversationId) : null
    if (!record) {
      record = await this.store.createConversation('新对话', 'claude_code')
      state = await this.store.getState()
    }
    this.activeId = record.id
    this.pending.set(record.id, structuredClone(record.pendingMessages))
    this.library = state
    this.initialized = true
    await this.ensureRuntime(record.id, record)
    // A saved model profile is the launch configuration from here on. A fresh
    // (or freshly upgraded) install has none yet — materialize the launch
    // environment as one editable profile so the model menu has something to
    // show instead of an empty list.
    if (!this.library.settings.modelProfiles.length && this.seedProfile) {
      const settings = await this.store.updateSettings({
        modelProfiles: [structuredClone(this.seedProfile)],
        activeModelProfileId: this.seedProfile.id
      })
      this.library = { ...this.library, settings }
      this.applyModelProfile(this.activeProfile())
    }
    this.emit()
  }

  /** The runtime for `id`, created (and restored from its record) on first
   *  use — first send, or the initial load. Displaying a conversation never
   *  comes through here. */
  private async ensureRuntime(id: string, record?: ConversationRecord): Promise<AgentRuntime> {
    const existing = this.runtimes.get(id)
    if (existing) return existing
    const rec = record ?? (await this.store.getConversation(id))
    if (!rec) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
    const runtime = this.createRuntime(() => this.handleRuntimeChange())
    runtime.conversationId = id
    runtime.restoreConversation(rec)
    runtime.setModelProfile(this.activeProfile())
    runtime.setMemoryContextProvider(this.turnHooks.memoryContext)
    if (this.library) {
      runtime.setIdentity({ userName: this.library.settings.userName, assistantName: this.library.settings.assistantName })
      runtime.setEffort(this.library.settings.effort)
      runtime.setGoalBudget(this.library.settings.goalMaxIterations, this.library.settings.goalMaxMinutes)
    }
    this.runtimes.set(id, runtime)
    if (!this.pending.has(id)) this.pending.set(id, structuredClone(rec.pendingMessages))
    const snap = runtime.getSnapshot()
    this.readiness = { modelReady: snap.modelReady, claudeCodeReady: snap.claudeCodeReady }
    return runtime
  }

  private runtimeIfAny(id: string | null | undefined): AgentRuntime | undefined {
    return id ? this.runtimes.get(id) : undefined
  }

  /** The publishing chain's handle on the displayed runtime (null for a cold
   *  conversation; the snapshot then comes straight from the stored record). */
  displayedRuntime(): AgentRuntime | null {
    return this.runtimeIfAny(this.activeId) ?? null
  }

  /** The first live runtime's command/skill catalog (the catalog is a
   *  property of the engine, identical across conversations). */
  commandCatalog(): { commands: string[]; skills: string[] } | undefined {
    for (const runtime of this.runtimes.values()) {
      const catalog = runtime.getCommandCatalog()
      if (catalog) return catalog
    }
    return undefined
  }

  /** Stops every live runtime — used when the app is quitting. */
  stopAll(): void {
    for (const runtime of this.runtimes.values()) runtime.stop()
  }

  getSnapshot(): ControllerSnapshot {
    if (!this.initialized || !this.library) throw new Error('会话库尚未就绪。')
    const id = this.activeId!
    const library = structuredClone(this.library)
    // Every live runtime reports its status into the library so the tab dots
    // are truthful for background conversations too.
    for (const [rid, runtime] of this.runtimes) {
      const summary = library.conversations.find((item) => item.id === rid)
      if (summary) summary.taskStatus = runtime.getSnapshot().taskStatus
    }
    const runtime = this.runtimes.get(id)
    if (runtime) {
      return {
        ...runtime.getSnapshot(),
        conversationId: id,
        conversationLibrary: library,
        pendingMessages: (this.pending.get(id) ?? []).map(visiblePending)
      }
    }
    // Cold conversation: served from its record, full timeline, idle.
    const record = this.displayedRecord?.id === id ? this.displayedRecord : null
    return {
      mode: record?.mode ?? 'claude_code',
      avatarState: 'idle',
      taskStatus: record?.taskStatus ?? 'idle',
      timeline: structuredClone(record?.timeline ?? []),
      timelineRevision: 0,
      conversationSpentYuan: typeof record?.spentYuan === 'number' && Number.isFinite(record.spentYuan) && record.spentYuan >= 0
        ? record.spentYuan : undefined,
      modelReady: this.readiness.modelReady,
      claudeCodeReady: this.readiness.claudeCodeReady,
      conversationId: id,
      conversationLibrary: library,
      pendingMessages: (this.pending.get(id) ?? []).map(visiblePending)
    }
  }

  handleRuntimeChange(): void {
    for (const [id, runtime] of this.runtimes) {
      const reason = runtime.getQueuePauseReason()
      if (reason) this.pausedQueues.set(id, reason)
    }
    this.emit()
  }

  private emit(): void {
    // The publisher decides when to clone a snapshot (it coalesces streaming bursts),
    // so emitting is just a signal here.
    if (this.initialized) this.onChange()
  }

  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.operations.then(task, task)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private assertIdle(id: string): void {
    const runtime = this.runtimes.get(id)
    if ((runtime?.isRunning() ?? false) || (this.pending.get(id)?.length ?? 0) > 0 || this.drains.has(id)) {
      throw new Error('这个会话仍有任务或待发送消息，请先等待完成或停止。')
    }
  }

  private async refreshLibrary(): Promise<void> {
    this.library = await this.store.getState()
    // Model clients track the current depth; setting it repeatedly is a no-op.
    for (const runtime of this.runtimes.values()) {
      runtime.setEffort(this.library.settings.effort)
      runtime.setGoalBudget(this.library.settings.goalMaxIterations, this.library.settings.goalMaxMinutes)
    }
    this.emit()
  }

  private async persistConversation(id: string, title?: string): Promise<void> {
    const pending = structuredClone(this.pending.get(id) ?? [])
    const runtime = this.runtimes.get(id)
    if (!runtime) {
      await this.store.updateConversation(id, {
        taskStatus: this.displayedRecord?.id === id ? this.displayedRecord.taskStatus : 'idle',
        pendingMessages: pending,
        ...(title ? { title } : {})
      })
      await this.refreshLibrary()
      return
    }
    await this.store.updateConversation(id, {
      ...runtime.exportConversationState(),
      taskStatus: runtime.getSnapshot().taskStatus,
      pendingMessages: pending,
      ...(title ? { title } : {})
    })
    await this.refreshLibrary()
  }

  /** Background nicety: ask the model for a tighter title once the first-line
   *  fallback has been written. The write-back only lands while the
   *  conversation still carries that exact fallback — a manual rename (or any
   *  later message) wins silently. Failures are ignored on purpose. */
  private async refineTitle(id: string, source: string, fallback: string): Promise<void> {
    const generate = this.generateTitle
    if (!generate) return
    // The first-line fallback title is always written; only the model pass
    // behind it is optional.
    if (!this.library?.settings.enableAutoTitleGeneration) return
    const clean = await generate(source).then((title) => title?.trim() ?? null, () => null)
    if (!clean || clean === fallback) return
    try {
      await this.serialize(async () => {
        if (this.library?.conversations.find((item) => item.id === id)?.title !== fallback) return
        await this.store.updateConversation(id, { title: clean })
        await this.refreshLibrary()
      })
    } catch (error) {
      this.onBackgroundError(error)
    }
  }

  /** Makes `id` the displayed conversation. No runtime is created or touched:
   *  a running conversation keeps running in the background. */
  private async setDisplayed(id: string): Promise<ConversationRecord> {
    let record = await this.store.getConversation(id)
    if (!record) {
      record = await this.store.createConversation('新对话', 'claude_code')
    }
    this.activeId = record.id
    if (!this.pending.has(record.id)) this.pending.set(record.id, structuredClone(record.pendingMessages))
    this.library = await this.store.getState()
    const runtime = this.runtimes.get(record.id)
    if (runtime) {
      // Coming back to a live conversation: the publisher owes a full timeline.
      runtime.forceFullTimeline()
      this.displayedRecord = null
    } else {
      this.displayedRecord = record
    }
    this.emit()
    return record
  }

  async getLibraryState(): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.getSnapshot().conversationLibrary
  }

  async listConversations(options: ConversationSearchOptions = {}): Promise<ConversationSummary[]> {
    await this.initialize()
    const summaries = await this.store.listConversations(options)
    return summaries.map((summary) => {
      const runtime = this.runtimes.get(summary.id)
      return runtime ? { ...summary, taskStatus: runtime.getSnapshot().taskStatus } : summary
    })
  }

  /** Acknowledges once safely queued on disk; it never waits for the model. */
  async sendMessage(text: string, attachments: UserAttachment[] = [], strategy: SendStrategy = 'queue', conversationId?: string): Promise<PendingMessage> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
    if (strategy !== 'queue' && strategy !== 'steer') {
      throw new ConversationStoreError('INVALID_INPUT', '不支持的发送方式。')
    }
    const clean = validateMessage(text, attachments)
    const sessionContext = await snapshotSessionMentions(clean, id, async (sourceId) => {
      const record = await this.store.getConversation(sourceId)
      if (!record) return null
      const sourceRuntime = this.runtimes.get(sourceId)
      if (!sourceRuntime) return record
      if (sourceRuntime.isRunning()) throw new ConversationStoreError('INVALID_INPUT', '引用会话仍在运行，请等它回复完成后再发送。')
      return { ...record, ...sourceRuntime.exportConversationState() }
    })
    const message: PendingMessage = {
      id: randomUUID(), text: clean, attachments: structuredClone(attachments), createdAt: new Date().toISOString(),
      ...(sessionContext ? { sessionContext } : {})
    }
    return this.serialize(async () => {
      // A slow @ reference can finish after a bulk archive/delete. Check the
      // destination inside the same controller operation that queues the turn.
      const target = await this.store.getConversation(id)
      if (!target) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
      if (target.archivedAt !== null) throw new ConversationStoreError('ARCHIVED_CONVERSATION', '请先恢复归档会话。')
      const runtime = await this.ensureRuntime(id, target)
      if (runtime.getSnapshot().mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
        throw new ConversationStoreError('INVALID_INPUT', '当前模型没有本地文件读取工具。请切换到 Claude Code 模式后再发送此文件。')
      }
      const queue = this.queueOf(id)
      if (this.pausedQueues.has(id) || runtime.getQueuePauseReason()) {
        if (clean === '/goal clear' && runtime.getSnapshot().mode === 'claude_code') {
          // Allow a goal-clear command through without releasing older work.
          this.scheduleDrain(id, message, true)
          return visiblePending(message)
        }
        this.pausedQueues.delete(id)
        runtime.resumeQueue()
        queue.unshift(message)
        await this.persistConversation(id)
        this.scheduleDrain(id)
        return visiblePending(message)
      }
      if (strategy === 'steer') {
        if (await runtime.steerMessage(message.text, message.attachments, message.sessionContext)) {
          await this.persistConversation(id)
          return visiblePending(message)
        }
        // Native steering is only available inside an active Claude Code turn.
        // Otherwise place this guidance next, without stopping the turn or dropping queued work.
        queue.unshift(message)
      } else if (!runtime.isRunning() && !queue.length && !this.drains.has(id)) {
        // Idle with an empty queue: hand the message to the drain as its seed
        // instead of queueing it first — going through the waiting strip made
        // it flash there for one snapshot before the drain moved it out, and
        // an idle send should just appear as a message. The drain still runs
        // its usual loop, so anything queued while this turn runs is picked
        // up the moment it ends.
        this.scheduleDrain(id, message)
        return visiblePending(message)
      } else {
        queue.push(message)
      }
      await this.persistConversation(id)
      this.scheduleDrain(id)
      return visiblePending(message)
    })
  }

  private queueOf(id: string): PendingMessage[] {
    let queue = this.pending.get(id)
    if (!queue) {
      queue = []
      this.pending.set(id, queue)
    }
    return queue
  }

  private generationOf(id: string): number {
    return this.drainGenerations.get(id) ?? 0
  }

  private scheduleDrain(id: string, seed?: PendingMessage, allowPausedSeed = false): void {
    const runtime = this.runtimes.get(id)
    if (!runtime || this.drains.has(id) || (!this.queueOf(id).length && !seed) || runtime.isRunning() ||
        (this.pausedQueues.has(id) && !allowPausedSeed)) return
    const generation = this.generationOf(id)
    const work = Promise.resolve().then(() => this.drain(id, generation, seed, allowPausedSeed))
    this.drains.set(id, { promise: work, generation })
    void work.then(
      () => undefined,
      (error: unknown) => {
        try { this.onBackgroundError(error) } catch { /* Keep the queue recoverable. */ }
      }
    ).finally(() => {
      const current = this.drains.get(id)
      if (current?.promise === work) this.drains.delete(id)
      const rt = this.runtimes.get(id)
      if (this.queueOf(id).length && rt && !rt.isRunning() && !this.pausedQueues.has(id)) this.scheduleDrain(id)
    })
  }

  private async drain(id: string, generation: number, seed?: PendingMessage, allowPausedSeed = false): Promise<void> {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    // The seed rides the first iteration without ever touching `pending`; from
    // the second iteration on this is the plain queue drain it always was.
    let seeded: PendingMessage | null = seed ?? null
    while (generation === this.generationOf(id) && !runtime.isRunning() &&
           (!this.pausedQueues.has(id) || (allowPausedSeed && seeded)) && (seeded || this.queueOf(id).length)) {
      const prepared = await this.serialize(async () => {
        if (generation !== this.generationOf(id)) return null
        const next = seeded ?? this.queueOf(id).shift()
        seeded = null
        if (!next) return null
        const source = next.text.trim() || next.attachments.map((item) => item.name).join('、')
        const title = this.library?.conversations.find((item) => item.id === id)?.title === '新对话'
          ? (next.text.split(/\r?\n/u, 1)[0].trim() || `附件：${next.attachments[0]?.name ?? '对话'}`).slice(0, 60)
          : undefined
        const beforeCount = runtime.exportConversationState().timeline.length
        const run = runtime.sendMessage(next.text, next.attachments, next.sessionContext)
        try {
          await this.persistConversation(id, title)
        } catch (error) {
          runtime.stop()
          throw error
        }
        return { run, title, source, beforeCount, userText: next.text }
      })
      if (!prepared) return
      if (prepared.title) void this.refineTitle(id, prepared.source, prepared.title)
      try {
        await prepared.run
        const snapshot = runtime.getSnapshot()
        if (snapshot.taskStatus === 'done' && snapshot.mode !== 'demo' && this.turnHooks.afterSuccessfulTurn) {
          const history = runtime.exportConversationState().history
          const last = history.at(-1)
          const turn: CompletedTurn = {
            conversationId: id, userText: prepared.userText,
            finalReply: last?.role === 'assistant' ? last.content : '',
            mode: snapshot.mode, timeline: snapshot.timeline.slice(prepared.beforeCount)
          }
          try { await this.turnHooks.afterSuccessfulTurn(turn) } catch (error) { this.onBackgroundError(error) }
        }
      } finally {
        if (generation === this.generationOf(id)) {
          await this.serialize(async () => {
            if (generation === this.generationOf(id)) await this.persistConversation(id)
          })
        }
      }
    }
  }

  /** The panel's kill switch for a runaway tool: hands the interrupt straight
   *  to the client; the turn ends through its normal path and queued work
   *  stays queued. */
  async interruptTurn(conversationId?: string): Promise<void> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (runtime) await runtime.interruptTurn()
  }

  async stop(conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    return this.serialize(async () => {
      this.drainGenerations.set(id, this.generationOf(id) + 1)
      this.drains.delete(id)
      this.pausedQueues.set(id, '任务已停止；待发送消息仍保留，发送新消息可继续。')
      this.runtimes.get(id)?.stop()
      await this.persistConversation(id)
    })
  }

  async removeQueued(id: string): Promise<void> {
    await this.initialize()
    return this.serialize(async () => {
      const owner = this.ownerOfQueued(id)
      if (!owner) throw new ConversationStoreError('NOT_FOUND', '找不到这条待发送消息。')
      this.pending.set(owner, this.queueOf(owner).filter((message) => message.id !== id))
      await this.persistConversation(owner)
    })
  }

  /** Delivers a queued message into the running turn right now (native steer).
   *  When the turn cannot take it, the message jumps to the front of the queue
   *  instead — it is never dropped. */
  async steerQueued(id: string): Promise<void> {
    await this.initialize()
    return this.serialize(async () => {
      const owner = this.ownerOfQueued(id)
      if (!owner) throw new ConversationStoreError('NOT_FOUND', '找不到这条待发送消息。')
      const queue = this.queueOf(owner)
      const index = queue.findIndex((message) => message.id === id)
      const message = queue.splice(index, 1)[0]
      const runtime = this.runtimes.get(owner)
      if (!runtime || !await runtime.steerMessage(message.text, message.attachments, message.sessionContext)) {
        queue.unshift(message)
      }
      await this.persistConversation(owner)
      this.scheduleDrain(owner)
    })
  }

  private ownerOfQueued(messageId: string): string | null {
    for (const [id, queue] of this.pending) {
      if (queue.some((message) => message.id === messageId)) return id
    }
    return null
  }

  async createConversation(title = '新对话'): Promise<ConversationRecord> {
    await this.initialize()
    return this.serialize(async () => {
      const mode = this.displayedRuntime()?.getSnapshot().mode
        ?? this.library?.conversations.find((item) => item.id === this.activeId)?.mode
        ?? 'claude_code'
      const record = await this.store.createConversation(title, mode)
      return this.setDisplayed(record.id).then(() => record)
    })
  }

  /** A cold history copy, not a provider checkpoint fork. Both the source
   *  runtime and the persisted record must still describe the same settled
   *  reply when the store creates the child. */
  async forkConversation(sourceId: string, expectedAssistantEntryId: string): Promise<string> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle(sourceId)
      const source = await this.store.getConversation(sourceId)
      if (!source) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
      if (source.archivedAt !== null) {
        throw new ConversationStoreError('ARCHIVED_CONVERSATION', '请先恢复归档会话。')
      }
      const runtime = this.runtimes.get(sourceId)
      if (runtime) {
        const snapshot = runtime.getSnapshot()
        if (snapshot.taskStatus !== 'done' || snapshot.proposal || snapshot.question || snapshot.plan) {
          throw new ConversationStoreError('INVALID_INPUT', '请等源会话完成回复。')
        }
        await this.persistConversation(sourceId)
      }
      // Persistence and other asynchronous work can yield to a live runtime.
      // Check again before the store's own atomic reply-ID validation.
      this.assertIdle(sourceId)
      if (runtime) {
        const snapshot = runtime.getSnapshot()
        if (snapshot.taskStatus !== 'done' || snapshot.proposal || snapshot.question || snapshot.plan) {
          throw new ConversationStoreError('INVALID_INPUT', '源会话状态已变化，请刷新后重试。')
        }
      }
      const record = await this.store.forkConversation(sourceId, expectedAssistantEntryId)
      await this.setDisplayed(record.id)
      return record.id
    })
  }

  async selectConversation(id: string): Promise<ConversationRecord> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.setActiveConversation(id)
      return this.setDisplayed(id)
    })
  }

  async renameConversation(id: string, title: string): Promise<ConversationRecord> {
    await this.initialize()
    return this.serialize(async () => {
      const record = await this.store.updateConversation(id, { title })
      await this.refreshLibrary()
      return record
    })
  }

  async archiveConversation(id: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle(id)
      await this.store.archiveConversation(id)
      this.releaseRuntime(id)
      await this.followActive()
      return structuredClone(this.library!)
    })
  }

  async restoreConversation(id: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.restoreConversation(id)
      await this.setDisplayed(id)
      return structuredClone(this.library!)
    })
  }

  async deleteConversation(id: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle(id)
      await this.store.deleteConversation(id)
      this.releaseRuntime(id)
      this.pending.delete(id)
      await this.followActive()
      return structuredClone(this.library!)
    })
  }

  async batchManageConversations(action: ConversationBatchAction, ids: string[]): Promise<ConversationBatchResult> {
    await this.initialize()
    return this.serialize(async () => {
      const blocked = new Set<string>()
      for (const [id, runtime] of this.runtimes) {
        if (runtime.isRunning()) blocked.add(id)
      }
      for (const [id, queue] of this.pending) {
        if (queue.length) blocked.add(id)
      }
      for (const id of this.drains.keys()) blocked.add(id)
      const result = await this.store.batchManageConversations(action, ids, blocked)
      for (const outcome of result.outcomes) {
        if (outcome.status !== 'updated' || (action !== 'archive' && action !== 'delete')) continue
        this.releaseRuntime(outcome.id)
        this.pending.delete(outcome.id)
      }
      await this.followActive()
      return result
    })
  }

  /** Deletes one turn — its message through every entry up to the next user
   *  line, plus the history behind it — from a conversation. Unlike
   *  deleteConversation this works while other turns run; only the target
   *  turn itself must be settled (the runtime refuses otherwise). */
  async deleteTurn(id: string, userEntryId: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      const runtime = this.runtimes.get(id)
      if (runtime) {
        runtime.deleteTurn(userEntryId)
      } else {
        const record = await this.store.getConversation(id)
        if (!record) throw new Error('会话不存在。')
        const next = deleteTurnEntries(record.timeline, record.history, userEntryId)
        // No live runtime: edit the stored record directly. The session id is
        // dropped there too — the model must forget the turn as well.
        await this.store.updateConversation(id, { timeline: next.timeline, history: next.history, sdkSessionId: null })
      }
      await this.persistConversation(id)
      return structuredClone(this.library!)
    })
  }

  /** After a conversation leaves the list (or a restored one arrives): show
   *  whatever the store now calls active, or refresh the library in place when
   *  nothing is left. The second half is the whole point — closing the last
   *  tab has to publish the empty list. Emitting the old copy instead left the
   *  renderer drawing a tab strip that no longer exists, and the panel stayed
   *  stuck on it until some other action refreshed the library. */
  private async followActive(): Promise<void> {
    const state = await this.store.getState()
    const nextId = state.activeConversationId
    if (nextId && nextId !== this.activeId) await this.setDisplayed(nextId)
    else await this.refreshLibrary()
  }

  /** A conversation that leaves the list lets its runtime (and SDK query) go. */
  private releaseRuntime(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.stop()
    this.runtimes.delete(id)
    this.drains.delete(id)
    this.drainGenerations.delete(id)
    this.pausedQueues.delete(id)
    if (this.displayedRecord?.id === id) this.displayedRecord = null
  }

  async updateSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
    await this.initialize()
    return this.serialize(async () => {
      const settings = await this.store.updateSettings(patch)
      if (patch.autoArchiveAfterDays !== undefined) await this.store.archiveInactiveConversations()
      if (patch.userName !== undefined || patch.assistantName !== undefined) {
        const identity = { userName: settings.userName, assistantName: settings.assistantName }
        for (const runtime of this.runtimes.values()) runtime.setIdentity(identity)
      }
      await this.refreshLibrary()
      return settings
    })
  }

  async setConversationPinned(id: string, pinned: boolean): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.setConversationPinned(id, pinned)
      await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async setTabOrder(ids: string[]): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.setTabOrder(ids)
      await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async archiveInactiveConversations(now?: Date): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.archiveInactiveConversations(now)
      await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async setModelMode(mode: ModelMode, conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    await this.serialize(async () => {
      if (this.queueOf(id).length) throw new Error('待发送消息未处理完，不能切换模型。')
      const runtime = await this.ensureRuntime(id)
      runtime.setModelMode(mode)
      await this.persistConversation(id)
    })
  }

  async setPlanMode(on: boolean, conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    await this.serialize(async () => {
      const runtime = await this.ensureRuntime(id)
      await runtime.setPlanMode(on)
    })
  }

  /** Creates or updates a model profile; the first one becomes active. */
  async saveModelProfile(profile: ModelProfile): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const settings = this.library!.settings
      const previous = settings.modelProfiles.find((item) => item.id === profile.id)
      if (previous && previous.baseUrl !== profile.baseUrl && !profile.apiKey) {
        throw new Error('更改端点时，请重新输入 API Key。')
      }
      const resolved: ModelProfile = {
        ...profile,
        apiKey: profile.apiKey || previous?.apiKey || '',
        extraEnv: profile.extraEnv === undefined ? previous?.extraEnv : profile.extraEnv,
        needsKeyReentry: false,
        apiKeyConfigured: undefined,
        extraEnvConfigured: undefined
      }
      if (!resolved.apiKey) throw new Error('请重新输入 API Key。')
      const modelProfiles = previous
        ? settings.modelProfiles.map((item) => item.id === resolved.id ? resolved : item)
        : [...settings.modelProfiles, resolved]
      const activeModelProfileId = settings.activeModelProfileId ?? profile.id
      await this.store.updateSettings({ modelProfiles, activeModelProfileId })
      await this.refreshLibrary()
      if (activeModelProfileId === resolved.id) this.applyModelProfile(resolved)
    })
  }

  async deleteModelProfile(id: string): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const modelProfiles = this.library!.settings.modelProfiles.filter((item) => item.id !== id)
      // A dangling active id degrades to null inside the store.
      await this.store.updateSettings({ modelProfiles })
      await this.refreshLibrary()
      this.applyModelProfile(this.activeProfile())
    })
  }

  /** Switches the model profile in use; null returns to the launch environment.
   *  A cloud session that belonged to the old endpoint resolves itself through
   *  the session-missing path on the next send. */
  async setModelProfile(id: string | null): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      await this.store.updateSettings({ activeModelProfileId: id })
      await this.refreshLibrary()
      this.applyModelProfile(this.activeProfile())
    })
  }

  /** Applies a profile to every live runtime; only the displayed conversation
   *  surfaces a refusal (a running session keeps its old client silently). */
  private applyModelProfile(profile: ModelProfile | null): void {
    for (const [id, runtime] of this.runtimes) {
      try {
        runtime.setModelProfile(profile)
      } catch (error) {
        if (id === this.activeId) throw error
      }
    }
  }

  private activeProfile(): ModelProfile | null {
    const settings = this.library?.settings
    if (!settings) return null
    return settings.modelProfiles.find((item) => item.id === settings.activeModelProfileId) ?? null
  }

  async getContextUsage(conversationId?: string): Promise<ContextUsageSnapshot> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) return { status: 'unavailable' }
    return runtime.getContextUsage()
  }

  async compactConversation(conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    await this.serialize(async () => {
      this.assertIdle(id)
      const runtime = this.runtimeIfAny(id)
      if (!runtime) throw new Error('这个会话还没有可以压缩的上下文。')
      await runtime.compactConversation()
      await this.persistConversation(id)
    })
  }

  async approveAction(id: string, conversationId?: string): Promise<void> {
    await this.initialize()
    const cid = conversationId ?? this.activeId
    const runtime = this.runtimeIfAny(cid)
    if (!runtime) throw new Error('找不到这个会话。')
    await runtime.approveAction(id)
    await this.serialize(async () => this.persistConversation(cid!))
    this.scheduleDrain(cid!)
  }

  async rejectAction(id: string, conversationId?: string): Promise<void> {
    await this.initialize()
    const cid = conversationId ?? this.activeId
    const runtime = this.runtimeIfAny(cid)
    if (!runtime) throw new Error('找不到这个会话。')
    runtime.rejectAction(id)
    await this.serialize(async () => this.persistConversation(cid!))
    this.scheduleDrain(cid!)
  }

  async answerQuestion(id: string, answers: AskAnswers | null, conversationId?: string): Promise<void> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    await runtime.answerQuestion(id, answers)
  }

  async answerPlan(id: string, approved: boolean, conversationId?: string): Promise<void> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    await runtime.answerPlan(id, approved)
  }
}
