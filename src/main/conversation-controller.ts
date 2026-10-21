import { randomUUID } from 'node:crypto'
import type { AgentCapabilities, AppSnapshot, ApprovalMode, AskAnswers, ContextUsageSnapshot, ConversationBatchAction, ConversationBatchResult, ModelMode, ModelProfile, TimelineEntry, UserAttachment } from '../shared/contracts'
import { AUTO_COMPACT_DEFAULT_PERCENT } from '../shared/contracts'
import { deleteTurnEntries, type AgentRuntime } from './agent-runtime'
import type { DialogueLine } from './deepseek'
import { containsSensitiveData } from './memory-service'
import { attachmentContext, validAttachmentList } from './local-context'
import { snapshotSessionMentions } from './session-context'
import { parseLibraryMentions } from '../shared/libraries'
import type { ConversationTarget } from './conversation-tools'
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

/** A draft longer than one message could ever be is capped instead of rejected
 *  — the panel saves on a debounce and must never fail loudly mid-typing. */
const MAX_DRAFT_CHARS = 8_000

export interface CompletedTurn {
  conversationId: string
  userText: string
  finalReply: string
  mode: ModelMode
  timeline: TimelineEntry[]
}

/** Resolves installed library keys (`kind:id`) into what the engine accepts.
 *  Unknown or uninstalled keys are dropped from `resolved`. */
export type LibraryLaunchResolver = (keys: string[]) => Promise<{
  resolved: string[]
  mcp: Record<string, unknown>
  plugins: string[]
}>

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
  /** Timestamps of recent cross-conversation sends, keyed source→target. */
  private readonly crossSends = new Map<string, number[]>()
  /** A displayed conversation without a runtime is served from this record. */
  private displayedRecord: ConversationRecord | null = null
  /** The last goal key written per conversation (see persistGoalChange). */
  private readonly writtenGoals = new Map<string, string>()
  private operations: Promise<void> = Promise.resolve()
  /** Last seen readiness flags — a cold snapshot still has to answer them. */
  private readiness = { modelReady: false, claudeCodeReady: false }
  private turnHooks: ConversationTurnHooks = {}
  private onDisplayedConversationChange?: (id: string | null) => void
  private onRuntimeConfigurationChange?: (conversationId?: string) => void
  private isSideBusy: (conversationId: string) => boolean = () => false
  private displayEpoch = 0

  constructor(
    private readonly store: ConversationStore,
    private readonly createRuntime: (conversationId: string, onChange: () => void) => AgentRuntime,
    private readonly onChange: () => void = () => {},
    private readonly onBackgroundError: (error: unknown) => void = () => {},
    private readonly generateTitle?: (source: string, locale?: 'auto' | 'zh' | 'en', model?: string) => Promise<string | null>,
    /** Materialized on first load when no profile exists yet — the launch
     *  environment's own setup, so the model menu never starts empty. */
    private readonly seedProfile?: ModelProfile,
    /** Installed-library lookups for @ references. */
    private readonly resolveLibraries?: LibraryLaunchResolver
  ) {}

  setTurnHooks(hooks: ConversationTurnHooks): void {
    this.turnHooks = hooks
    for (const runtime of this.runtimes.values()) runtime.setMemoryContextProvider(hooks.memoryContext)
  }

  /** Side chats are owned by their main conversation. All paths that change
   * the displayed ID go through setDisplayed or followActive. */
  setDisplayChangeListener(listener: (id: string | null) => void): void {
    this.onDisplayedConversationChange = listener
  }

  setRuntimeConfigurationChangeListener(listener: (conversationId?: string) => void): void {
    this.onRuntimeConfigurationChange = listener
  }

  setSideBusyPredicate(predicate: (conversationId: string) => boolean): void {
    this.isSideBusy = predicate
  }

  displayedConversationId(): string | null { return this.activeId }
  displayedConversationEpoch(): number { return this.displayEpoch }

  /** Cheap parent guard for hot side-stream callbacks: avoid cloning the
   * entire main timeline just to check the displayed tab's membership. */
  displayedLiveConversationId(): string | null {
    const id = this.activeId
    if (!id || this.library?.activeConversationId !== id) return null
    return this.library.conversations.some((record) => record.id === id && record.archivedAt === null) ? id : null
  }

  liveConversationIds(): ReadonlySet<string> {
    return new Set(this.library?.conversations.filter((record) => record.archivedAt === null)
      .map((record) => record.id) ?? [])
  }

  currentSettings(): ConversationSettings {
    if (!this.library) throw new Error('会话库尚未就绪。')
    return this.library.settings
  }

  /** A bounded cold copy of visible, settled dialogue for a temporary child.
   * It excludes tool output, expanded attachments, hidden session context and
   * the parent's SDK session ID. The child will never display these seed lines. */
  captureSideChatHistory(): DialogueLine[] {
    const id = this.activeId
    if (!id) return []
    const runtime = this.runtimes.get(id)
    const runtimeSnapshot = runtime?.getSnapshot()
    const timeline = runtimeSnapshot?.timeline ??
      (this.displayedRecord?.id === id ? this.displayedRecord.timeline : [])
    const status = runtimeSnapshot?.taskStatus ?? this.displayedRecord?.taskStatus
    const history = runtime?.exportConversationState().history ??
      (this.displayedRecord?.id === id ? this.displayedRecord.history : [])
    const historyUsers = history.map((line, at) => line.role === 'user' ? at : -1).filter((at) => at >= 0)
    const settled: DialogueLine[] = []
    let turn: DialogueLine[] = []
    let sensitiveTurn = false
    let turnStart = 0
    let seenUsers = 0
    const flush = (complete: boolean): void => {
      const start = historyUsers[turnStart]
      const end = historyUsers[seenUsers] ?? history.length
      // Streaming assistant fragments can remain visible after a failed or
      // stopped turn. Only a final assistant committed to model history proves
      // the turn actually settled.
      const committedReply = start !== undefined && history.slice(start, end).some((line) => line.role === 'assistant')
      if (complete && committedReply && !sensitiveTurn && turn.some((line) => line.role === 'user') &&
          turn.some((line) => line.role === 'assistant')) settled.push(...turn)
      turn = []
      sensitiveTurn = false
      turnStart = seenUsers
    }
    for (const entry of timeline) {
      if (entry.kind === 'user' && !entry.interrupted) flush(true)
      if (entry.kind !== 'user' && entry.kind !== 'assistant') continue
      if (entry.kind === 'user') seenUsers += 1
      const content = entry.text.trim()
      if (containsSensitiveData(content)) sensitiveTurn = true
      if (!content || sensitiveTurn) continue
      turn.push({ role: entry.kind, content })
    }
    flush(status === 'done')
    const result: DialogueLine[] = []
    let remaining = 16_000
    for (const line of settled.slice(-20).reverse()) {
      if (line.content.length > remaining) break
      result.unshift(line)
      remaining -= line.content.length
    }
    return result
  }

  allConversationsIdle(): boolean {
    return this.drains.size === 0 && [...this.runtimes.values()].every((runtime) => !runtime.isRunning()) &&
      [...this.pending.values()].every((queue) => queue.length === 0)
  }

  /** 除 exceptId 之外，是否还有对话在跑：回合、排队消息、临时会话或 drain。
   *  重启请示用它判断“还有没有别人的任务”，不把请求者自己的回合算成别人。 */
  hasRunningWorkExcept(exceptId?: string): boolean {
    const ids = new Set<string>([...this.runtimes.keys(), ...this.pending.keys(), ...this.drains.keys()])
    for (const id of ids) {
      if (id === exceptId) continue
      if (this.drains.has(id) || (this.pending.get(id)?.length ?? 0) > 0) return true
      if (this.runtimes.get(id)?.isRunning()) return true
      if (this.isSideBusy(id)) return true
    }
    return false
  }

  /** Drops every live runtime after the workspace changed. Each conversation
   *  rebuilds its client on the next send, against the new cwd. Callers must
   *  check allConversationsIdle first. */
  async resetForWorkspace(): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      for (const id of [...this.runtimes.keys()]) this.releaseRuntime(id)
      this.onRuntimeConfigurationChange?.()
      this.emit()
    })
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
    const runtime = this.createRuntime(id, () => this.handleRuntimeChange())
    runtime.conversationId = id
    runtime.restoreConversation(rec)
    runtime.setModelProfile(this.activeProfile())
    runtime.setMemoryContextProvider(this.turnHooks.memoryContext)
    if (this.library) {
      runtime.setIdentity({ userName: this.library.settings.userName, assistantName: this.library.settings.assistantName })
      runtime.setEffort(this.library.settings.effort)
      runtime.setWebSearch(this.library.settings.webSearchEnabled !== false)
      runtime.setPersona(this.library.settings.personaId ?? 'xiaojing')
      runtime.setAutoCompactPercent(this.library.settings.autoCompactPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)
      runtime.syncPromptSettings(this.library.settings.outputStyle, this.library.settings.appendSystemPrompt, this.library.settings.loadUserSettings !== false)
      runtime.setGoalBudget(this.library.settings.goalMaxIterations, this.library.settings.goalMaxMinutes)
    }
    // A budget-exceeded goal is cleared through the same /goal clear path the
    // banner uses; stop() alone would leave the CLI's loop armed.
    runtime.setGoalClearHandler(() => {
      void this.clearGoal(id).catch((error: unknown) => {
        console.error('Goal budget clear failed:', error)
      })
    })
    // Conversation-to-conversation messaging, exposed to the model as the
    // conversations MCP tools.
    runtime.setConversationBridge({
      list: () => this.listConversationTargets(),
      send: (target, text, sourceId) => this.sendToConversation(target, text, sourceId)
    })
    // A conversation keeps the entries added with @ across restarts.
    if (this.resolveLibraries && rec.activeLibraries?.length) {
      try {
        const launch = await this.resolveLibraries(rec.activeLibraries)
        runtime.setLibraries(launch.mcp, launch.plugins)
      } catch {
        // A broken library index must not block the conversation; the next
        // send resolves it again.
      }
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

  /** Stops every live runtime — used when the app is quitting. Pass
   *  `silent=true` on quit/restart so closing the app writes no stop notice. */
  stopAll(silent = false): void {
    for (const runtime of this.runtimes.values()) runtime.stop(undefined, silent)
  }

  /** Closes model processes (DSH runtimes, SDK queries) after the final save.
   *  Keep this separate from stopAll: stopping preserves the transcript, while
   *  disposal releases the child processes and loopback servers. */
  async disposeAll(): Promise<void> {
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(runtimes.map((runtime) => runtime.dispose()))
  }

  /** Writes every live conversation's current timeline before the app exits.
   *  A turn persists when it finishes; without this, whatever happened since
   *  the last save vanished on restart. */
  async flushAll(): Promise<void> {
    if (!this.initialized) return
    for (const id of [...this.runtimes.keys()]) {
      try {
        await this.persistConversation(id)
      } catch (error) {
        this.onBackgroundError(error)
      }
    }
  }

  /** 设置窗口要显示的内核能力。 */
  getCapabilities(): AgentCapabilities {
    return this.displayedRuntime()?.getCapabilities() ?? {}
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
    const savedMode = record?.mode ?? 'claude_code'
    const availableMode = savedMode === 'claude_code' && this.readiness.claudeCodeReady ? 'claude_code'
      : savedMode === 'live' && this.readiness.modelReady ? 'live' : 'demo'
    return {
      mode: availableMode,
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
      this.persistGoalChange(id, runtime)
    }
    this.emit()
  }

  /** A goal is durable state, not turn state. Writing it only when a turn ends
   *  loses it whenever the window closes while the loop is mid-run — so every
   *  change goes to disk right away. The change check is a string compare
   *  against what was last written, because this runs on every runtime tick. */
  private persistGoalChange(id: string, runtime: AgentRuntime): void {
    const goal = runtime.getGoal()
    const key = goal ? `${goal.condition}\u0000${goal.phase}\u0000${goal.iterations ?? ''}` : ''
    if (this.writtenGoals.get(id) === key) return
    this.writtenGoals.set(id, key)
    void this.serialize(async () => {
      const record = await this.store.getConversation(id)
      if (!record || record.archivedAt !== null) return
      await this.store.updateConversation(id, { goal })
    }).catch((error: unknown) => this.onBackgroundError(error))
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
    if ((runtime?.isRunning() ?? false) || (this.pending.get(id)?.length ?? 0) > 0 ||
        this.drains.has(id) || this.isSideBusy(id)) {
      throw new Error('这个会话仍有任务或待发送消息，请先等待完成或停止。')
    }
  }

  private isBusyForAutoArchive(id: string): boolean {
    return this.isSideBusy(id) || (this.runtimes.get(id)?.isRunning() ?? false) ||
      this.drains.has(id) || (this.pending.get(id)?.length ?? 0) > 0
  }

  private async autoArchiveInactive(now?: Date): Promise<void> {
    const state = await this.store.archiveInactiveConversations(now, (id) => this.isBusyForAutoArchive(id))
    for (const record of state.conversations) {
      if (record.archivedAt !== null) this.releaseRuntime(record.id)
    }
  }

  private async refreshLibrary(): Promise<void> {
    this.library = await this.store.getState()
    // Model clients track the current depth; setting it repeatedly is a no-op.
    for (const runtime of this.runtimes.values()) {
      runtime.setEffort(this.library.settings.effort)
      runtime.setWebSearch(this.library.settings.webSearchEnabled !== false)
      runtime.setPersona(this.library.settings.personaId ?? 'xiaojing')
      runtime.setAutoCompactPercent(this.library.settings.autoCompactPercent ?? AUTO_COMPACT_DEFAULT_PERCENT)
      runtime.syncPromptSettings(this.library.settings.outputStyle, this.library.settings.appendSystemPrompt, this.library.settings.loadUserSettings !== false)
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
    const locale = this.library?.settings.titleLocale ?? 'auto'
    const model = this.library?.settings.titleModel ?? 'deepseek-flash'
    const clean = await generate(source, locale, model).then((title) => title?.trim() ?? null, () => null)
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
    const nextLibrary = await this.store.getState()
    const previousId = this.activeId
    this.activeId = record.id
    if (previousId !== record.id) {
      this.displayEpoch += 1
    }
    if (!this.pending.has(record.id)) this.pending.set(record.id, structuredClone(record.pendingMessages))
    this.library = nextLibrary
    const runtime = this.runtimes.get(record.id)
    if (runtime) {
      // Coming back to a live conversation: the publisher owes a full timeline.
      runtime.forceFullTimeline()
      this.displayedRecord = null
    } else {
      this.displayedRecord = record
    }
    if (previousId !== record.id) this.onDisplayedConversationChange?.(record.id)
    this.emit()
    return record
  }

  /** The visible identity of a conversation, used when it sends a message. */
  conversationSender(id: string): { name: string; badge: string } | undefined {
    const found = this.library?.conversations.find((item) => item.id === id)
    const name = found?.title.trim().slice(0, 40)
    if (!name) return undefined
    return { name, badge: name.slice(0, 1) }
  }

  /** Records a message from another local conversation without starting a
   *  model turn in this one. */
  async appendExternalMessage(text: string, from: { name: string; badge: string },
    conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
    const clean = text.trim()
    if (!clean) return
    const name = from.name.trim().slice(0, 40)
    const badge = from.badge.trim().slice(0, 2)
    if (!name || !badge) throw new ConversationStoreError('INVALID_INPUT', '消息来源无效。')
    await this.serialize(async () => {
      const target = await this.store.getConversation(id)
      if (!target) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
      const runtime = await this.ensureRuntime(id, target)
      runtime.appendExternalMessage({ name, badge }, clean.slice(0, 8_000))
      await this.persistConversation(id)
    })
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
  /** 系统提示不冒充用户：进模型上下文和时间线，但不出用户头像和发言框。 */
  async sendSystemMessage(text: string, conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
    const target = await this.store.getConversation(id)
    if (!target) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
    const runtime = await this.ensureRuntime(id, target)
    await runtime.sendMessage(text, [], '', undefined, true)
  }

  async sendMessage(text: string, attachments: UserAttachment[] = [], strategy: SendStrategy = 'queue', conversationId?: string, divider = false): Promise<PendingMessage> {
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
      ...(divider ? { divider: true } : {}),
      ...(sessionContext ? { sessionContext } : {})
    }
    return this.serialize(async () => {
      // A slow @ reference can finish after a bulk archive/delete. Check the
      // destination inside the same controller operation that queues the turn.
      const target = await this.store.getConversation(id)
      if (!target) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
      if (target.archivedAt !== null) throw new ConversationStoreError('ARCHIVED_CONVERSATION', '请先恢复归档会话。')
      const runtime = await this.ensureRuntime(id, target)
      // A foreground subagent blocks the running turn. The user just sent
      // something, so release those tasks to the background and let the main
      // turn take the message now.
      await runtime.releaseForegroundSubagents().catch(() => undefined)
      // @ references add library entries to this conversation. Installed keys
      // persist; unknown ones are ignored rather than failing the send.
      const mentioned = parseLibraryMentions(clean).map((ref) => `${ref.kind}:${ref.id}`)
      if (this.resolveLibraries && (mentioned.length || target.activeLibraries?.length)) {
        const launch = await this.resolveLibraries([...new Set([...(target.activeLibraries ?? []), ...mentioned])])
        const previous = target.activeLibraries ?? []
        if (launch.resolved.length !== previous.length || launch.resolved.some((key) => !previous.includes(key))) {
          target.activeLibraries = launch.resolved
          await this.store.updateConversation(id, { activeLibraries: launch.resolved })
        }
        runtime.setLibraries(launch.mcp, launch.plugins)
      }
      if (runtime.getSnapshot().mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
        throw new ConversationStoreError('INVALID_INPUT', '当前模型没有本地文件读取工具。请切换到小鲸引擎模式后再发送此文件。')
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
        // 已有一条待确认的插话，或投递失败：消息留在队列，不覆盖、不打断当前回合。
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
        const run = runtime.sendMessage(next.text, next.attachments, next.sessionContext, undefined, false, next.divider === true)
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

  /** Ends a running goal. The CLI only clears one through its own /goal clear
   *  command, and that command has to travel as a turn of its own: steered
   *  into the running turn it arrived as plain conversation, the CLI never
   *  executed it, and the goal stayed — the panel's stop button looked dead.
   *  So the loop's current turn is interrupted first (queue and pause state
   *  untouched), then the command is queued behind it; the drain already
   *  waiting on that turn sends it the moment the turn winds down. */
  async clearGoal(conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    const runtime = this.runtimes.get(id)
    if (!runtime || runtime.getSnapshot().mode !== 'claude_code') return
    if (runtime.isRunning()) await runtime.interruptTurn()
    await this.sendMessage('/goal clear', [], 'queue', id)
  }

  /** The composer text as typed, kept per conversation so closing the window
   *  never loses a half-written message. The panel saves on a debounce; the
   *  write publishes nothing — the draft is renderer state and the list
   *  summaries do not carry it. */
  async saveDraft(id: string, text: string): Promise<void> {
    await this.initialize()
    if (typeof text !== 'string') throw new ConversationStoreError('INVALID_INPUT', '草稿格式无效。')
    return this.serialize(async () => {
      const record = await this.store.getConversation(id)
      if (!record || record.archivedAt !== null) return
      if ((record.draft ?? '') === text) return
      await this.store.updateConversation(id, { draft: text.slice(0, MAX_DRAFT_CHARS) })
    })
  }

  async getDraft(id: string): Promise<string> {
    await this.initialize()
    const record = await this.store.getConversation(id)
    return record?.draft ?? ''
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
        // 已有待确认的插话或投递失败：退回队列，不覆盖也不打断。
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
      if (action === 'archive' || action === 'delete') {
        for (const id of ids) if (this.isSideBusy(id)) blocked.add(id)
      }
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
    else {
      if (!nextId && this.activeId) {
        this.displayEpoch += 1
        await this.refreshLibrary()
        this.onDisplayedConversationChange?.(null)
      } else {
        await this.refreshLibrary()
      }
    }
  }

  /** A conversation that leaves the list lets its runtime (and SDK query) go. */
  private releaseRuntime(id: string): void {
    const runtime = this.runtimes.get(id)
    if (!runtime) return
    runtime.stop()
    void runtime.dispose().catch(() => undefined)
    this.runtimes.delete(id)
    this.drains.delete(id)
    this.drainGenerations.delete(id)
    this.pausedQueues.delete(id)
    this.writtenGoals.delete(id)
    if (this.displayedRecord?.id === id) this.displayedRecord = null
  }

  async updateSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
    await this.initialize()
    return this.serialize(async () => {
      const settings = await this.store.updateSettings(patch)
      if (patch.autoArchiveAfterDays !== undefined) await this.autoArchiveInactive()
      if (patch.userName !== undefined || patch.assistantName !== undefined) {
        const identity = { userName: settings.userName, assistantName: settings.assistantName }
        for (const runtime of this.runtimes.values()) runtime.setIdentity(identity)
      }
      // Prompt-shaping changes must reach runtimes before refreshLibrary's
      // quiet sync, so each runtime can discard a transcript that recorded
      // the old system prompt.
      if (patch.outputStyle !== undefined || patch.appendSystemPrompt !== undefined || patch.loadUserSettings !== undefined) {
        for (const runtime of this.runtimes.values()) {
          if (patch.outputStyle !== undefined) runtime.setOutputStyle(patch.outputStyle)
          if (patch.appendSystemPrompt !== undefined) runtime.setAppendSystemPrompt(patch.appendSystemPrompt)
          if (patch.loadUserSettings !== undefined) runtime.setLoadUserSettings(patch.loadUserSettings)
        }
      }
      await this.refreshLibrary()
      if (patch.modelProfiles !== undefined || patch.activeModelProfileId !== undefined ||
          patch.userName !== undefined || patch.assistantName !== undefined || patch.effort !== undefined) {
        this.onRuntimeConfigurationChange?.()
      }
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
      await this.autoArchiveInactive(now)
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
      this.onRuntimeConfigurationChange?.(id)
    })
  }

  async setPlanMode(on: boolean, conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    await this.serialize(async () => {
      const runtime = await this.ensureRuntime(id)
      await runtime.setPlanMode(on)
      // The switch itself is state worth keeping: closing the window right
      // after flipping it must not lose it.
      await this.persistConversation(id)
    })
  }

  async setApprovalMode(mode: ApprovalMode, conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    await this.serialize(async () => {
      const runtime = await this.ensureRuntime(id)
      await runtime.setApprovalMode(mode)
      await this.persistConversation(id)
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
      this.onRuntimeConfigurationChange?.()
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
      this.onRuntimeConfigurationChange?.()
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
      this.onRuntimeConfigurationChange?.()
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

  async answerPermission(id: string, allow: boolean, conversationId?: string): Promise<void> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    await runtime.answerPermission(id, allow)
  }

  /** Moves one foreground subagent to the background; the main turn resumes. */
  async backgroundTask(toolUseId: string, conversationId?: string): Promise<boolean> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    return runtime.backgroundSubagent(toolUseId)
  }

  /** Stops one Task-tool subagent without touching the main turn. */
  async stopTask(taskId: string, conversationId?: string): Promise<void> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    await runtime.stopSubagent(taskId)
  }

  /** Sends a message into one running subagent's own stream. */
  async messageSubagent(toolUseId: string, text: string, conversationId?: string): Promise<boolean> {
    await this.initialize()
    const runtime = this.runtimeIfAny(conversationId ?? this.activeId)
    if (!runtime) throw new Error('找不到这个会话。')
    return runtime.messageSubagent(toolUseId, text)
  }

  /** Conversations the model may address, with live running state. */
  private listConversationTargets(): ConversationTarget[] {
    return (this.library?.conversations ?? []).map((item) => ({
      id: item.id,
      title: item.title,
      running: this.runtimes.get(item.id)?.isRunning() ?? false,
      archived: item.archivedAt !== null
    }))
  }

  /** One conversation handing a message to another. The body carries its
   *  source, so the receiving model and the reader both know where it came
   *  from. A small rate limit stops two models from volleying forever. */
  async sendToConversation(target: string, text: string, sourceConversationId?: string): Promise<{ id: string; title: string }> {
    await this.initialize()
    const library = this.library
    if (!library) throw new ConversationStoreError('NOT_FOUND', '会话库尚未就绪。')
    const clean = text.trim()
    if (!clean) throw new ConversationStoreError('INVALID_INPUT', '消息不能为空。')
    const matches = library.conversations.filter((item) => item.id === target || item.title === target)
    if (matches.length === 0) throw new ConversationStoreError('NOT_FOUND', '找不到目标对话。')
    if (matches.length > 1) throw new ConversationStoreError('INVALID_INPUT', '对话标题不唯一，请改用 id。')
    const destination = matches[0]
    if (destination.archivedAt !== null) throw new ConversationStoreError('ARCHIVED_CONVERSATION', '目标对话已归档，请先恢复。')
    const sourceId = sourceConversationId ?? this.activeId ?? undefined
    if (sourceId === destination.id) throw new ConversationStoreError('INVALID_INPUT', '不能给当前对话自己发消息。')
    const key = `${sourceId ?? '-'}>${destination.id}`
    const now = Date.now()
    const recent = (this.crossSends.get(key) ?? []).filter((at) => now - at < 60_000)
    if (recent.length >= 3) throw new ConversationStoreError('INVALID_INPUT', '转达太频繁，请稍后再试。')
    recent.push(now)
    this.crossSends.set(key, recent)
    const source = sourceId ? library.conversations.find((item) => item.id === sourceId) : undefined
    const body = source ? `【来自对话「${source.title}」】\n${clean}` : clean
    await this.sendMessage(body, [], 'queue', destination.id)
    return { id: destination.id, title: destination.title }
  }

  /** Explicit resume for a queue paused by a stop, a goal budget or a persona
   *  switch. The next send would resume it anyway; this lets the goal banner
   *  do it without inventing a message. */
  async resumeQueue(conversationId?: string): Promise<void> {
    await this.initialize()
    const id = conversationId ?? this.activeId
    if (!id) return
    const runtime = this.runtimes.get(id)
    if (!this.pausedQueues.has(id) && !runtime?.getQueuePauseReason()) return
    this.pausedQueues.delete(id)
    runtime?.resumeQueue()
    this.scheduleDrain(id)
    this.emit()
    await this.persistConversation(id)
  }
}
