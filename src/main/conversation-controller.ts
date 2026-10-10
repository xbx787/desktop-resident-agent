import { randomUUID } from 'node:crypto'
import type { AppSnapshot, AskAnswers, ContextUsageSnapshot, ModelMode, ModelProfile, UserAttachment } from '../shared/contracts'
import type { AgentRuntime } from './agent-runtime'
import { attachmentContext, validAttachmentList } from './local-context'
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

/** Keeps one AgentRuntime bound to one persisted conversation at a time. */
export class ConversationController {
  private initialized = false
  private initialization: Promise<void> | null = null
  private library: ConversationLibraryState | null = null
  private activeId: string | null = null
  private pending: PendingMessage[] = []
  private operations: Promise<void> = Promise.resolve()
  private drainPromise: Promise<void> | null = null
  private drainGeneration = 0

  constructor(
    private readonly store: ConversationStore,
    private readonly runtime: AgentRuntime,
    private readonly onChange: () => void = () => {},
    private readonly onBackgroundError: (error: unknown) => void = () => {},
    private readonly generateTitle?: (source: string) => Promise<string | null>,
    /** Materialized on first load when no profile exists yet — the launch
     *  environment's own setup, so the model menu never starts empty. */
    private readonly seedProfile?: ModelProfile
  ) {}

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
      record = await this.store.createConversation('新对话', this.runtime.getSnapshot().mode)
      state = await this.store.getState()
    }
    this.activeId = record.id
    this.pending = structuredClone(record.pendingMessages)
    this.library = state
    this.initialized = true
    this.runtime.restoreConversation(record)
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
    }
    const activeProfile = this.library.settings.modelProfiles
      .find((item) => item.id === this.library!.settings.activeModelProfileId)
    if (activeProfile) this.runtime.setModelProfile(activeProfile)
    this.runtime.setIdentity({ userName: this.library.settings.userName, assistantName: this.library.settings.assistantName })
    this.emit()
  }

  getSnapshot(): ControllerSnapshot {
    if (!this.initialized || !this.library) throw new Error('会话库尚未就绪。')
    const runtime = this.runtime.getSnapshot()
    const library = structuredClone(this.library)
    const activeSummary = library.conversations.find((item) => item.id === this.activeId)
    if (activeSummary) activeSummary.taskStatus = runtime.taskStatus
    return {
      ...runtime,
      conversationLibrary: library,
      pendingMessages: structuredClone(this.pending)
    }
  }

  handleRuntimeChange(): void {
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

  private assertIdle(): void {
    if (this.runtime.isRunning() || this.pending.length > 0 || this.drainPromise) {
      throw new Error('当前会话仍有任务或待发送消息，请先等待完成或停止。')
    }
  }

  private async refreshLibrary(): Promise<void> {
    this.library = await this.store.getState()
    // Model clients track the current depth; setting it repeatedly is a no-op.
    this.runtime.setEffort(this.library.settings.effort)
    this.emit()
  }

  private async persistActive(title?: string): Promise<void> {
    if (!this.activeId) throw new Error('没有可保存的当前会话。')
    await this.store.updateConversation(this.activeId, {
      ...this.runtime.exportConversationState(),
      taskStatus: this.runtime.getSnapshot().taskStatus,
      pendingMessages: structuredClone(this.pending),
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

  private async activateStoreSelection(): Promise<ConversationRecord> {
    let state = await this.store.getState()
    let record = state.activeConversationId ? await this.store.getConversation(state.activeConversationId) : null
    if (!record) {
      record = await this.store.createConversation('新对话', this.runtime.getSnapshot().mode)
      state = await this.store.getState()
    }
    this.activeId = record.id
    this.pending = structuredClone(record.pendingMessages)
    this.library = state
    this.runtime.restoreConversation(record)
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
    const taskStatus = this.runtime.getSnapshot().taskStatus
    return summaries.map((summary) => summary.id === this.activeId ? { ...summary, taskStatus } : summary)
  }

  /** Acknowledges once safely queued on disk; it never waits for the model. */
  async sendMessage(text: string, attachments: UserAttachment[] = [], strategy: SendStrategy = 'queue'): Promise<PendingMessage> {
    await this.initialize()
    if (strategy !== 'queue' && strategy !== 'steer') {
      throw new ConversationStoreError('INVALID_INPUT', '不支持的发送方式。')
    }
    const clean = validateMessage(text, attachments)
    if (this.runtime.getSnapshot().mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
      throw new ConversationStoreError('INVALID_INPUT', '当前模型没有本地文件读取工具。请切换到 Claude Code 模式后再发送此文件。')
    }
    const message: PendingMessage = {
      id: randomUUID(), text: clean, attachments: structuredClone(attachments), createdAt: new Date().toISOString()
    }
    return this.serialize(async () => {
      if (strategy === 'steer') {
        if (await this.runtime.steerMessage(message.text, message.attachments)) {
          await this.persistActive()
          return structuredClone(message)
        }
        // Native steering is only available inside an active Claude Code turn.
        // Otherwise place this guidance next, without stopping the turn or dropping queued work.
        this.pending.unshift(message)
      } else if (!this.runtime.isRunning() && !this.pending.length && !this.drainPromise) {
        // Idle with an empty queue: hand the message to the drain as its seed
        // instead of queueing it first — going through the waiting strip made
        // it flash there for one snapshot before the drain moved it out, and
        // an idle send should just appear as a message. The drain still runs
        // its usual loop, so anything queued while this turn runs is picked
        // up the moment it ends.
        this.scheduleDrain(message)
        return structuredClone(message)
      } else {
        this.pending.push(message)
      }
      await this.persistActive()
      this.scheduleDrain()
      return structuredClone(message)
    })
  }

  private scheduleDrain(seed?: PendingMessage): void {
    if (this.drainPromise || (!this.pending.length && !seed) || this.runtime.isRunning()) return
    const generation = this.drainGeneration
    const work = Promise.resolve().then(() => this.drain(generation, seed))
    this.drainPromise = work
    void work.then(
      () => undefined,
      (error: unknown) => {
        try { this.onBackgroundError(error) } catch { /* Keep the queue recoverable. */ }
      }
    ).finally(() => {
      if (this.drainPromise === work) this.drainPromise = null
      if (this.pending.length && !this.runtime.isRunning()) this.scheduleDrain()
    })
  }

  private async drain(generation: number, seed?: PendingMessage): Promise<void> {
    // The seed rides the first iteration without ever touching `pending`; from
    // the second iteration on this is the plain queue drain it always was.
    let seeded: PendingMessage | null = seed ?? null
    while (generation === this.drainGeneration && !this.runtime.isRunning() && (seeded || this.pending.length)) {
      const prepared = await this.serialize(async () => {
        if (generation !== this.drainGeneration) return null
        const next = seeded ?? this.pending.shift()
        seeded = null
        if (!next) return null
        const id = this.activeId
        const source = next.text.trim() || next.attachments.map((item) => item.name).join('、')
        const title = this.library?.conversations.find((item) => item.id === this.activeId)?.title === '新对话'
          ? (next.text.split(/\r?\n/u, 1)[0].trim() || `附件：${next.attachments[0]?.name ?? '对话'}`).slice(0, 60)
          : undefined
        const run = this.runtime.sendMessage(next.text, next.attachments)
        try {
          await this.persistActive(title)
        } catch (error) {
          this.runtime.stop()
          throw error
        }
        return { run, id, title, source }
      })
      if (!prepared) return
      if (prepared.id && prepared.title) void this.refineTitle(prepared.id, prepared.source, prepared.title)
      try {
        await prepared.run
      } finally {
        if (generation === this.drainGeneration) {
          await this.serialize(async () => {
            if (generation === this.drainGeneration) await this.persistActive()
          })
        }
      }
    }
  }

  /** The panel's kill switch for a runaway tool: hands the interrupt straight
   *  to the client; the turn ends through its normal path and queued work
   *  stays queued. */
  async interruptTurn(): Promise<void> {
    await this.initialize()
    await this.runtime.interruptTurn()
  }

  async stop(): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      this.drainGeneration += 1
      this.drainPromise = null
      this.runtime.stop()
      this.pending = []
      await this.persistActive()
    })
  }

  async removeQueued(id: string): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const before = this.pending.length
      this.pending = this.pending.filter((message) => message.id !== id)
      if (before === this.pending.length) throw new ConversationStoreError('NOT_FOUND', '找不到这条待发送消息。')
      await this.persistActive()
    })
  }

  /** Delivers a queued message into the running turn right now (native steer).
   *  When the turn cannot take it, the message jumps to the front of the queue
   *  instead — it is never dropped. */
  async steerQueued(id: string): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const index = this.pending.findIndex((message) => message.id === id)
      if (index < 0) throw new ConversationStoreError('NOT_FOUND', '找不到这条待发送消息。')
      const message = this.pending.splice(index, 1)[0]
      if (!await this.runtime.steerMessage(message.text, message.attachments)) {
        this.pending.unshift(message)
      }
      await this.persistActive()
      this.scheduleDrain()
    })
  }

  async createConversation(title = '新对话'): Promise<ConversationRecord> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle()
      const record = await this.store.createConversation(title, this.runtime.getSnapshot().mode)
      return this.activateStoreSelection().then(() => record)
    })
  }

  async selectConversation(id: string): Promise<ConversationRecord> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle()
      await this.store.setActiveConversation(id)
      return this.activateStoreSelection()
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
      if (id === this.activeId) this.assertIdle()
      await this.store.archiveConversation(id)
      if (id === this.activeId) await this.activateStoreSelection()
      else await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async restoreConversation(id: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      this.assertIdle()
      await this.store.restoreConversation(id)
      await this.activateStoreSelection()
      return structuredClone(this.library!)
    })
  }

  async deleteConversation(id: string): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      if (id === this.activeId) this.assertIdle()
      await this.store.deleteConversation(id)
      if (id === this.activeId) await this.activateStoreSelection()
      else await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async updateSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
    await this.initialize()
    return this.serialize(async () => {
      const settings = await this.store.updateSettings(patch)
      if (patch.autoArchiveAfterDays !== undefined) await this.store.archiveInactiveConversations()
      if (patch.userName !== undefined || patch.assistantName !== undefined) {
        this.runtime.setIdentity({ userName: settings.userName, assistantName: settings.assistantName })
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

  async archiveInactiveConversations(now?: Date): Promise<ConversationLibraryState> {
    await this.initialize()
    return this.serialize(async () => {
      await this.store.archiveInactiveConversations(now)
      await this.refreshLibrary()
      return structuredClone(this.library!)
    })
  }

  async setModelMode(mode: ModelMode): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      if (this.pending.length) throw new Error('待发送消息未处理完，不能切换模型。')
      this.runtime.setModelMode(mode)
      await this.persistActive()
    })
  }

  async setPlanMode(on: boolean): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      this.runtime.setPlanMode(on)
    })
  }

  /** Creates or updates a model profile; the first one becomes active. */
  async saveModelProfile(profile: ModelProfile): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const settings = this.library!.settings
      const exists = settings.modelProfiles.some((item) => item.id === profile.id)
      const modelProfiles = exists
        ? settings.modelProfiles.map((item) => item.id === profile.id ? profile : item)
        : [...settings.modelProfiles, profile]
      const activeModelProfileId = settings.activeModelProfileId ?? profile.id
      await this.store.updateSettings({ modelProfiles, activeModelProfileId })
      await this.refreshLibrary()
      if (activeModelProfileId === profile.id) this.runtime.setModelProfile(profile)
    })
  }

  async deleteModelProfile(id: string): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      const modelProfiles = this.library!.settings.modelProfiles.filter((item) => item.id !== id)
      // A dangling active id degrades to null inside the store.
      await this.store.updateSettings({ modelProfiles })
      await this.refreshLibrary()
      this.runtime.setModelProfile(this.activeProfile())
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
      this.runtime.setModelProfile(this.activeProfile())
    })
  }

  private activeProfile(): ModelProfile | null {
    const settings = this.library?.settings
    if (!settings) return null
    return settings.modelProfiles.find((item) => item.id === settings.activeModelProfileId) ?? null
  }

  async getContextUsage(): Promise<ContextUsageSnapshot> {
    await this.initialize()
    return this.runtime.getContextUsage()
  }

  async compactConversation(): Promise<void> {
    await this.initialize()
    await this.serialize(async () => {
      this.assertIdle()
      await this.runtime.compactConversation()
      await this.persistActive()
    })
  }

  async approveAction(id: string): Promise<void> {
    await this.initialize()
    await this.runtime.approveAction(id)
    await this.serialize(async () => this.persistActive())
    this.scheduleDrain()
  }

  async rejectAction(id: string): Promise<void> {
    await this.initialize()
    this.runtime.rejectAction(id)
    await this.serialize(async () => this.persistActive())
    this.scheduleDrain()
  }

  async answerQuestion(id: string, answers: AskAnswers | null): Promise<void> {
    await this.initialize()
    await this.runtime.answerQuestion(id, answers)
  }

  async answerPlan(id: string, approved: boolean): Promise<void> {
    await this.initialize()
    await this.runtime.answerPlan(id, approved)
  }
}
