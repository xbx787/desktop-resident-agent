import type { AgentGoal, AppSnapshot, AskAnswers, ContextUsageSnapshot, EffortLevel, ModelMode, ModelProfile, ProposedAction, TimelineEntry, UserAttachment } from '../shared/contracts'
import { isImageAttachmentName } from '../shared/image-preview'
import { usageSpendYuan } from '../shared/deepseek-pricing'
import { toolLabel } from '../shared/tool-labels'
import { AgentTurnError } from './agent-errors'
import type { DialogueLine, ModelClient, ModelReply, ModelToolEvent } from './deepseek'
import type { ConversationRecord } from './conversation-store'
import { NoteStore, type NoteDraft } from './note-store'
import { attachmentContext, expandFileMentions, validAttachmentList } from './local-context'

const DEMO_HINT = '演示模式仅支持「记录：内容」的测试笔记流程。'

/** The pictures among a message's attachments, ready for the timeline. */
function messageImages(attachments: readonly UserAttachment[]): Array<{ name: string; path: string }> | undefined {
  const images = attachments
    .filter((item) => item.path && isImageAttachmentName(item.name))
    .map(({ name, path }) => ({ name, path: path! }))
  return images.length ? images : undefined
}

/** Deletes one turn from a timeline and the history that mirrors it — the
 *  user's message through to the entry before the next user line. The Nth
 *  user entry maps to the Nth history user line: the send and steer paths
 *  write both in lockstep. Returns new arrays; throws when the pair cannot be
 *  aligned rather than guessing at a partial delete. */
export function deleteTurnEntries(timeline: TimelineEntry[], history: DialogueLine[],
  userEntryId: string): { timeline: TimelineEntry[]; history: DialogueLine[] } {
  const index = timeline.findIndex((entry) => entry.id === userEntryId && entry.kind === 'user')
  if (index < 0) throw new Error('这轮对话已经找不到了。')
  let end = index + 1
  while (end < timeline.length && timeline[end].kind !== 'user') end += 1
  const ordinal = timeline.slice(0, index).filter((entry) => entry.kind === 'user').length
  const userStarts = history.map((line, at) => (line.role === 'user' ? at : -1)).filter((at) => at >= 0)
  const start = userStarts[ordinal]
  if (start === undefined) throw new Error('历史记录与消息对不上，未做删除。')
  const nextStart = userStarts[ordinal + 1] ?? history.length
  return {
    timeline: [...timeline.slice(0, index), ...timeline.slice(end)],
    history: [...history.slice(0, start), ...history.slice(nextStart)]
  }
}

export class AgentRuntime {
  private readonly state: AppSnapshot
  private readonly history: DialogueLine[] = []
  private readonly configuredModel: ModelClient | undefined
  private readonly claudeCodeModel: ModelClient | undefined
  private model: ModelClient | undefined
  private draft?: NoteDraft
  private activeRequest?: AbortController
  private currentTurnUserId?: string
  private generation = 0
  private contextGeneration = 0
  private sdkSessionId: string | null = null
  private thinkingOpen = false
  private goalMaxIterations = 30
  private goalMaxMinutes = 180
  private goalTimer?: ReturnType<typeof setTimeout>
  private queuePauseReason: string | null = null
  private memoryContextProvider?: () => Promise<string>
  /** Which conversation this runtime owns; assigned by the controller at creation. */
  conversationId = ''
  /** Entries changed since the publisher's last take (upsert by id). */
  private timelineDirty = new Map<string, TimelineEntry>()
  /** The timeline revision the publisher last reported; -1 = never. */
  private timelineSentRevision = -1

  constructor(
    private readonly store: NoteStore,
    model: ModelClient | undefined,
    private readonly onChange: () => void = () => {},
    claudeCodeModel?: ModelClient,
    private readonly workspaceRoot?: string
  ) {
    this.configuredModel = model
    this.claudeCodeModel = claudeCodeModel
    this.model = claudeCodeModel ?? model
    claudeCodeModel?.setGoalListener?.((goal) => this.observeGoal(goal))
    claudeCodeModel?.setPlanModeListener?.((on) => {
      this.state.planMode = on
      this.emit()
    })
    // A parked AskUserQuestion lives in the snapshot while the panel shows it.
    claudeCodeModel?.setQuestionListener?.((question) => {
      this.state.question = question;
      this.emit();
    });
    // A parked ExitPlanMode lives there too until the plan is approved or sent back.
    claudeCodeModel?.setPlanListener?.((plan) => {
      this.state.plan = plan;
      this.emit();
    });
    this.state = {
      mode: claudeCodeModel ? 'claude_code' : model ? 'live' : 'demo',
      modelReady: Boolean(model),
      claudeCodeReady: Boolean(claudeCodeModel),
      avatarState: 'idle',
      taskStatus: 'idle',
      effort: 'max',
      timeline: [],
      timelineRevision: 0
    }
  }

  setModelMode(mode: ModelMode): void {
    if (this.isRunning()) throw new Error('任务进行中时不能切换模型。')
    if (mode === 'live' && !this.configuredModel) throw new Error('尚未配置 DeepSeek API Key。')
    if (mode === 'claude_code' && !this.claudeCodeModel) throw new Error('Claude Code 或 DeepSeek API Key 尚未就绪。')
    if (this.state.mode === mode) return
    this.contextGeneration += 1
    if (this.state.mode === 'claude_code') this.disposeClaudeQuery()
    this.clearGoalTimer()
    this.state.goal = null
    this.queuePauseReason = null
    // A resumed SDK session would otherwise miss turns handled by another model.
    this.sdkSessionId = null
    this.model = mode === 'claude_code' ? this.claudeCodeModel : mode === 'live' ? this.configuredModel : undefined
    this.state.mode = mode
    this.state.contextUsage = { status: 'unavailable' }
    this.state.taskMetrics = undefined
    this.state.modelReady = Boolean(this.configuredModel)
    this.add('system', mode === 'claude_code' ? '已切换到 Claude Code + DeepSeek。' : mode === 'live' ? '已切换到 DeepSeek Flash。' : '已切换到演示模式。')
  }

  /** Memory is added only to the model request copy, never to the visible or saved history. */
  setMemoryContextProvider(provider?: () => Promise<string>): void {
    this.memoryContextProvider = provider
  }

  /** Planned-first sessions: research and propose before touching anything. */
  async setPlanMode(on: boolean): Promise<void> {
    if (Boolean(this.state.planMode) === on) return
    if (this.state.mode !== 'claude_code' || !this.claudeCodeModel?.setPlanMode) {
      throw new Error('当前模型不支持计划模式。')
    }
    try {
      const confirmed = await this.claudeCodeModel.setPlanMode(on)
      if (confirmed === false) {
        this.add('system', '计划模式请求已保存，等待下次 SDK 会话启动后确认。')
        return
      }
    } catch {
      this.add('system', '计划模式切换失败，SDK 未确认。')
      throw new Error('计划模式切换失败，SDK 未确认。')
    }
    this.state.planMode = on
    this.add('system', on ? '已开启计划模式：先研究并给出计划，再动手执行。' : '已关闭计划模式。')
  }

  setGoalBudget(maxIterations: number, maxMinutes: number): void {
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 300 ||
        !Number.isSafeInteger(maxMinutes) || maxMinutes < 1 || maxMinutes > 1440) {
      throw new Error('目标预算必须在允许范围内。')
    }
    if (this.goalMaxIterations === maxIterations && this.goalMaxMinutes === maxMinutes) return
    this.goalMaxIterations = maxIterations
    this.goalMaxMinutes = maxMinutes
    this.armGoalTimer()
    this.checkGoalBudget()
  }

  getQueuePauseReason(): string | null { return this.queuePauseReason }

  resumeQueue(): void { this.queuePauseReason = null }

  /** A requested goal is only a local request until an SDK event confirms it. */
  private trackGoal(text: string): void {
    const match = /^\/goal(?:\s+([\s\S]+))?$/iu.exec(text.trim())
    const condition = match?.[1]?.trim() ?? ''
    if (!match || !condition) return // Bare /goal just asks the CLI for its state.
    if (/^clear$/iu.test(condition)) {
      if (this.state.goal) {
        this.state.goal = { ...this.state.goal, phase: 'stopping', statusMessage: '已请求清除目标，等待 CLI 确认。' }
      }
    } else {
      this.state.goal = { condition, phase: 'requested', startedAt: new Date().toISOString() }
      this.armGoalTimer()
    }
    this.emit()
  }

  private observeGoal(goal: AgentGoal | null): void {
    if (goal === null) {
      this.state.goal = null
      this.clearGoalTimer()
      this.emit()
      return
    }
    const previous = this.state.goal
    const startedAt = previous?.condition === goal.condition ? previous.startedAt : goal.startedAt
    this.state.goal = { condition: goal.condition, phase: 'confirmed', startedAt,
      ...(goal.iterations !== undefined ? { iterations: goal.iterations } : {}),
      ...(goal.iterations === undefined ? { statusMessage: 'CLI 未提供轮数，仍按时间上限保护。' } : {}) }
    this.armGoalTimer()
    this.emit()
    this.checkGoalBudget()
  }

  private clearGoalTimer(): void {
    if (this.goalTimer) clearTimeout(this.goalTimer)
    this.goalTimer = undefined
  }

  private armGoalTimer(): void {
    this.clearGoalTimer()
    const goal = this.state.goal
    if (!goal || this.queuePauseReason) return
    const elapsed = Date.now() - Date.parse(goal.startedAt)
    const remaining = this.goalMaxMinutes * 60_000 - (Number.isFinite(elapsed) ? elapsed : 0)
    this.goalTimer = setTimeout(() => this.checkGoalBudget(), Math.max(0, remaining))
    this.goalTimer.unref?.()
  }

  private checkGoalBudget(): void {
    const goal = this.state.goal
    if (!goal || this.queuePauseReason) return
    if (goal.iterations !== undefined && goal.iterations >= this.goalMaxIterations) {
      this.stop(`目标达到 ${this.goalMaxIterations} 轮上限，已停止；待发送消息仍保留。`)
    } else if (Date.now() - Date.parse(goal.startedAt) >= this.goalMaxMinutes * 60_000) {
      this.stop(`目标达到 ${this.goalMaxMinutes} 分钟上限，已停止；待发送消息仍保留。`)
    }
  }

  /** Thinking depth is a plain model-layer knob: it goes to every client and
   *  nothing else changes. Persistence belongs to the conversation store. */
  setEffort(level: EffortLevel): void {
    if (this.state.effort === level) return
    this.state.effort = level
    this.configuredModel?.setEffort?.(level)
    this.claudeCodeModel?.setEffort?.(level)
    this.onChange()
  }

  getSnapshot(): AppSnapshot {
    // `timeline` rides along by reference — it is the one big field, the
    // publisher keeps its payload down to the changed entries
    // (takeTimelineDelta), and every consumer treats it as read-only. The
    // rest keeps the old deep-copy semantics (snapshot in time), which is
    // what lets callers observe intermediate states like a running task's
    // metrics without them mutating underfoot.
    const { timeline, ...rest } = this.state
    return { ...structuredClone(rest), timeline }
  }

  async getContextUsage(): Promise<ContextUsageSnapshot> {
    const model = this.model as (ModelClient & { getContextUsage?: (sessionId?: string | null) => Promise<ContextUsageSnapshot> }) | undefined
    if (this.state.mode !== 'claude_code' || !model?.getContextUsage) return { status: 'unavailable' }
    const generation = this.contextGeneration
    const sessionId = this.sdkSessionId
    const usage = await model.getContextUsage(sessionId)
    if (generation !== this.contextGeneration || this.state.mode !== 'claude_code' || sessionId !== this.sdkSessionId) {
      return { status: 'unavailable' }
    }
    this.state.contextUsage = { ...usage, checkedAt: new Date().toISOString() }
    this.emit()
    return structuredClone(this.state.contextUsage)
  }

  async compactConversation(): Promise<void> {
    if (this.isRunning()) throw new Error('当前任务完成后才能手动压缩上下文。')
    const model = this.model as (ModelClient & { compact?: (sessionId?: string | null) => Promise<ContextUsageSnapshot> }) | undefined
    if (this.state.mode !== 'claude_code' || !model?.compact) throw new Error('当前模型不支持手动压缩。')
    this.state.contextCompacting = true
    this.emit()
    const generation = this.contextGeneration
    const sessionId = this.sdkSessionId
    try {
      const usage = await model.compact(sessionId)
      if (generation !== this.contextGeneration || sessionId !== this.sdkSessionId) return
      this.state.contextUsage = { ...usage, checkedAt: new Date().toISOString() }
      this.add('system', usage.compactionOutcome === 'not_needed'
        ? '当前对话较短，暂不需要压缩。'
        : '上下文已压缩，可以继续当前对话。')
    } finally {
      this.state.contextCompacting = false
      this.emit()
    }
  }

  isRunning(): boolean {
    return this.isBusy() || Boolean(this.state.contextCompacting)
  }

  /** Adds guidance to the active SDK turn at its next native execution boundary. */
  async steerMessage(rawText: string, attachments: UserAttachment[] = [], sessionContext = ''): Promise<boolean> {
    if (!this.isBusy() || this.state.mode !== 'claude_code') return false
    if (!validAttachmentList(attachments)) return false
    const text = rawText.trim()
    const context = attachmentContext(attachments)
    const prompt = [text, context].filter(Boolean).join('\n\n')
    if (!prompt || prompt.length > 8_000) return false
    const model = this.model as (ModelClient & { steer?: (text: string) => Promise<boolean> | boolean }) | undefined
    if (!model?.steer) return false
    const expandedText = this.workspaceRoot
      ? await expandFileMentions(text, this.workspaceRoot, { maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 })
      : { prompt: text }
    const expandedPrompt = [expandedText.prompt, context, sessionContext].filter(Boolean).join('\n\n')
    if (!await model.steer(expandedPrompt)) return false
    this.history.push({ role: 'user', content: prompt, ...(sessionContext ? { sessionContext } : {}) })
    // Native guidance continues the same SDK task. Its final response lands
    // after this user line, so put the task footer on that visible turn.
    this.currentTurnUserId = this.add('user', attachments.length ? `${text || '请阅读附件并帮助我。'}\n附件：${attachments.map(({ name }) => name).join('、')}` : text, messageImages(attachments)).id
    return true
  }

  restoreConversation(record: ConversationRecord): void {
    if (this.isRunning()) throw new Error('任务进行中时不能切换会话。')
    this.contextGeneration += 1
    if (this.state.mode === 'claude_code') this.disposeClaudeQuery()
    this.generation += 1
    this.history.splice(0, this.history.length, ...structuredClone(record.history))
    // A restore replaces the whole history; the next publish sends it in full.
    this.state.timeline = structuredClone(record.timeline)
    this.state.timelineRevision += 1
    this.timelineDirty.clear()
    this.timelineSentRevision = -1
    this.state.taskStatus = record.taskStatus
    this.state.avatarState = 'idle'
    this.state.currentTask = undefined
    this.state.proposal = undefined
    this.state.question = null
    this.state.plan = null
    this.state.contextUsage = { status: 'unavailable' }
    this.state.contextCompacting = false
    this.state.taskMetrics = undefined
    this.state.conversationSpentYuan = typeof record.spentYuan === 'number' && Number.isFinite(record.spentYuan) && record.spentYuan >= 0
      ? record.spentYuan : undefined
    this.currentTurnUserId = undefined
    // A restored CLI goal is visible, but its state must be confirmed again by
    // an SDK event before we call it active or count another iteration.
    this.clearGoalTimer()
    this.state.goal = record.goal
      ? { ...record.goal, phase: 'unverified', statusMessage: '会话恢复后尚未收到 CLI 目标状态确认。' }
      : null
    this.queuePauseReason = null
    this.draft = undefined
    this.thinkingOpen = false
    const mode = record.mode === 'claude_code' && this.claudeCodeModel ? 'claude_code'
      : record.mode === 'live' && this.configuredModel ? 'live' : 'demo'
    this.state.mode = mode
    this.model = mode === 'claude_code' ? this.claudeCodeModel : mode === 'live' ? this.configuredModel : undefined
    // The CLI keeps the whole transcript on disk, so a saved session is always
    // the best context source — even when the last stored turn is an unanswered
    // user message (that turn simply continues inside the resumed session).
    this.sdkSessionId = mode === 'claude_code' ? record.sdkSessionId : null

    if (mode !== 'claude_code') this.state.goal = null
    else this.armGoalTimer()
    this.emit()
  }

  exportConversationState(): Pick<ConversationRecord, 'mode' | 'timeline' | 'history' | 'sdkSessionId' | 'spentYuan'> {
    return {
      mode: this.state.mode,
      timeline: structuredClone(this.state.timeline),
      history: structuredClone(this.history),
      sdkSessionId: this.sdkSessionId,
      spentYuan: this.state.conversationSpentYuan
    }
  }

  async sendMessage(rawText: string, attachments: UserAttachment[] = [], sessionContext = ''): Promise<void> {
    const text = rawText.trim()
    if (!validAttachmentList(attachments)) {
      this.add('system', '附件数量或大小超过限制。')
      return
    }
    if (this.state.mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
      this.add('system', '当前模型没有本地文件读取工具。请切换到 Claude Code 模式后再发送此文件。')
      return
    }
    const context = attachmentContext(attachments)
    const prompt = [text, context].filter(Boolean).join('\n\n')
    if (!prompt) return
    if (prompt.length > 8_000) {
      this.add('system', '单条消息目前最多 8000 字。')
      return
    }
    if (this.isRunning()) {
      this.add('system', '当前任务尚未结束；请先处理待批准操作，或按“停止”。')
      return
    }

    if (this.state.mode === 'claude_code') this.trackGoal(text)
    this.generation += 1
    const currentGeneration = this.generation
    this.draft = undefined
    this.state.proposal = undefined
    this.state.currentTask = (text || `阅读附件：${attachments.map(({ name }) => name).join('、')}`).slice(0, 140)
    this.state.taskMetrics = { startedAt: new Date().toISOString() }
    this.state.taskStatus = 'planning'
    this.state.avatarState = 'thinking'
    this.history.push({ role: 'user', content: prompt, ...(sessionContext ? { sessionContext } : {}) })
    this.currentTurnUserId = this.add('user', attachments.length ? `${text || '请阅读附件并帮助我。'}\n附件：${attachments.map(({ name }) => name).join('、')}` : text, messageImages(attachments)).id

    if (!this.model) {
      const noteBody = /^(?:记录|记下|测试笔记)\s*[:：]\s*([\s\S]+)$/u.exec(text)?.[1]?.trim()
      if (noteBody) {
        const title = noteBody.split(/\r?\n/u, 1)[0].slice(0, 40) || '测试笔记'
        this.offerNote(title, noteBody)
      } else {
        this.finishWithText(DEMO_HINT)
      }
      return
    }

    const abort = new AbortController()
    this.activeRequest = abort
    let progressEntryId: string | undefined
    let progressSegment: number | undefined
    let thinkingEntryId: string | undefined
    let thinkingSegment: number | undefined
    try {
      // Persist the frozen source separately from visible user text. Rebuild
      // the model's transcript on every turn, including after app restart.
      // DeepSeek's own last-20-line window naturally ages old references out.
      const modelHistory = this.history.map((line) => ({
        ...line,
        content: line.sessionContext ? `${line.content}\n\n${line.sessionContext}` : line.content
      }))
      if (this.workspaceRoot) {
        const expanded = await expandFileMentions(text, this.workspaceRoot, { maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 })
        modelHistory[modelHistory.length - 1] = {
          ...modelHistory[modelHistory.length - 1],
          content: [expanded.prompt, context, sessionContext].filter(Boolean).join('\n\n')
        }
      }
      if (this.memoryContextProvider) {
        const memory = await this.memoryContextProvider().catch(() => '')
        if (memory) {
          const last = modelHistory[modelHistory.length - 1]
          modelHistory[modelHistory.length - 1] = { ...last, content: `${last.content}\n\n<user_memory>\n${memory}\n</user_memory>` }
        }
      }
      if (abort.signal.aborted || currentGeneration !== this.generation) return
      const reply = await this.model.respond(modelHistory, abort.signal, (partial, segment) => {
        if (segment !== undefined && segment !== progressSegment) {
          progressSegment = segment
          progressEntryId = undefined
        }
        if (currentGeneration !== this.generation || !partial) return
        this.closeThinkingEntries()
        if (!progressEntryId) {
          progressEntryId = crypto.randomUUID()
          const entry: TimelineEntry = { id: progressEntryId, time: new Date().toISOString(), kind: 'assistant', text: partial }
          this.state.timeline.push(entry)
          this.markTimelineDirty(entry)
        } else {
          const entry = this.state.timeline.find((item) => item.id === progressEntryId)
          if (entry) {
            entry.text = partial
            this.markTimelineDirty(entry)
          }
        }
        this.emit()
      }, this.state.mode === 'claude_code' ? this.sdkSessionId : null,
      (event) => {
        if (event.phase === 'start') progressEntryId = undefined
        this.recordToolEvent(event, currentGeneration)
      }, (usage) => {
        if (currentGeneration !== this.generation || !this.state.taskMetrics) return
        this.state.taskMetrics.usedTokens = usage.total
        this.state.taskMetrics.usage = usage
        this.emit()
      }, (partial, segment) => {
        if (currentGeneration !== this.generation || !partial) return
        if (segment !== thinkingSegment) {
          thinkingSegment = segment
          thinkingEntryId = undefined
        }
        if (!thinkingEntryId) {
          this.closeThinkingEntries()
          thinkingEntryId = crypto.randomUUID()
          const entry: TimelineEntry = { id: thinkingEntryId, time: new Date().toISOString(), kind: 'thinking', text: partial }
          this.state.timeline.push(entry)
          this.markTimelineDirty(entry)
        } else {
          const entry = this.state.timeline.find((item) => item.id === thinkingEntryId)
          if (entry) {
            entry.text = partial
            this.markTimelineDirty(entry)
          }
        }
        this.thinkingOpen = true
        this.emit()
      })
      if (currentGeneration !== this.generation) return
      this.handleModelReply(reply, progressEntryId)
      if (this.state.mode === 'claude_code') await this.getContextUsage().catch(() => undefined)
    } catch (error) {
      if (currentGeneration !== this.generation) return
      // A failure that invalidates the resume id must not be remembered for
      // the next turn; the local history replays it into a fresh session.
      const failure = error instanceof AgentTurnError ? error.failure : undefined
      if (failure?.invalidatesSession) this.sdkSessionId = null
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.closeThinkingEntries()
      this.finishRunningTools('未完成')
      this.add('system', error instanceof Error ? error.message : '模型请求失败。')
    } finally {
      if (currentGeneration === this.generation) this.activeRequest = undefined
    }
  }

  async approveAction(id: string): Promise<void> {
    if (this.state.taskStatus !== 'awaiting_approval' || !this.draft || this.draft.id !== id) {
      this.add('system', '这项操作已经失效，未执行写入。')
      return
    }
    const draft = this.draft
    this.draft = undefined
    this.state.proposal = undefined
    this.state.taskStatus = 'executing'
    this.state.avatarState = 'acting'
    this.add('system', '已批准，正在创建新的测试笔记。')

    try {
      const target = await this.store.createAndVerify(draft)
      this.state.taskStatus = 'verifying'
      this.emit()
      const message = `已创建并读回核验：${target}`
      this.state.taskStatus = 'done'
      this.state.avatarState = 'success'
      this.history.push({ role: 'assistant', content: message })
      this.add('tool', message)
    } catch (error) {
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.add('system', error instanceof Error ? error.message : '测试笔记写入失败。')
    }
  }

  rejectAction(id: string): void {
    if (this.state.taskStatus !== 'awaiting_approval' || this.draft?.id !== id) return
    this.draft = undefined
    this.state.proposal = undefined
    this.state.taskStatus = 'cancelled'
    this.state.avatarState = 'idle'
    this.add('system', '已拒绝，本次没有写入文件。')
  }

  /** Forwards the panel's answer (or skip) to the model that parked the question. */
  async answerQuestion(id: string, answers: AskAnswers | null): Promise<void> {
    const model = this.model as (ModelClient & { answerQuestion?: (id: string, answers: AskAnswers | null) => boolean }) | undefined
    if (!model?.answerQuestion) throw new Error('当前没有等待回答的问题。')
    if (!model.answerQuestion(id, answers)) throw new Error('这个问题已经失效。')
  }

  /** Forwards the panel's verdict on a parked plan to the model that asked. */
  async answerPlan(id: string, approved: boolean): Promise<void> {
    const model = this.model as (ModelClient & { answerPlan?: (id: string, approved: boolean) => boolean }) | undefined
    if (!model?.answerPlan) throw new Error('当前没有等待批准的计划。')
    if (!model.answerPlan(id, approved)) throw new Error('这个计划已经失效。')
  }

  /** Ask the current model to abort what this turn is doing — the panel's
   *  kill switch for a runaway command. Only the SDK client has such an
   *  operation; every other model has no local tool to stop. */
  async interruptTurn(): Promise<void> {
    if (this.model !== this.claudeCodeModel) return
    await this.claudeCodeModel?.interrupt?.()
  }

  /** Points the SDK client at a saved model profile (null = launch
   *  environment). A cloud session from the old endpoint resolves itself
   *  through the session-missing path on the next send. */
  setModelProfile(profile: ModelProfile | null): void {
    this.claudeCodeModel?.setProvider?.(profile ?? undefined)
  }

  /** The names the persona addresses, applied to every client. */
  setIdentity(identity: { userName: string; assistantName: string }): void {
    this.claudeCodeModel?.setIdentity?.(identity)
    this.configuredModel?.setIdentity?.(identity)
  }

  stop(reason?: string): void {
    if (this.state.mode !== 'claude_code' && (this.state.taskStatus === 'executing' || this.state.taskStatus === 'verifying')) {
      this.add('system', '写入已经开始，当前步骤会完成读回验证；不会继续执行其他动作。')
      return
    }
    if (!this.isBusy() && !this.state.goal) return
    if (this.state.goal) {
      this.state.goal = { ...this.state.goal, phase: 'unverified',
        statusMessage: reason ?? '已请求停止，但 CLI 尚未确认目标清除；可用 /goal 查询。' }
      this.clearGoalTimer()
      this.queuePauseReason = reason ?? '任务已停止；待发送消息仍保留，发送新消息可继续。'
    }
    if (!this.isBusy()) {
      this.add('system', reason ?? '已请求停止目标；CLI 状态尚未确认。')
      return
    }
    this.generation += 1
    this.activeRequest?.abort()
    this.activeRequest = undefined
    // Stop interrupts the running turn only; the CLI session stays resumable
    // so the next message still remembers the conversation so far.
    this.draft = undefined
    this.state.proposal = undefined
    this.state.question = null
    this.state.plan = null
    this.state.taskStatus = 'cancelled'
    this.state.avatarState = 'idle'
    this.closeThinkingEntries()
    this.finishRunningTools('已停止')
    this.add('system', reason ?? (this.state.mode === 'claude_code' ? '已请求停止 Claude Code；正在执行的外部动作可能仍会完成。' : '任务已停止，待批准的操作已取消。'))
  }

  /** Removes one turn from the timeline and the model history, and drops the
   *  SDK session so the trimmed history replays into a fresh one — a deleted
   *  turn must not survive inside the old session. Refused while the target
   *  turn is the one still running. */
  deleteTurn(userEntryId: string): void {
    const index = this.state.timeline.findIndex((entry) => entry.id === userEntryId && entry.kind === 'user')
    if (index < 0) throw new Error('这轮对话已经找不到了。')
    let end = index + 1
    while (end < this.state.timeline.length && this.state.timeline[end].kind !== 'user') end += 1
    if (end >= this.state.timeline.length && this.isRunning()) {
      throw new Error('这一轮还在运行，结束后才能删除。')
    }
    const next = deleteTurnEntries(this.state.timeline, this.history, userEntryId)
    this.state.timeline = next.timeline
    this.history.splice(0, this.history.length, ...next.history)
    // Deletions have no delta form: republish the timeline in full.
    this.state.timelineRevision += 1
    this.timelineDirty.clear()
    this.timelineSentRevision = -1
    this.sdkSessionId = null
    this.emit()
  }

  private isBusy(): boolean {
    return ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(this.state.taskStatus)
  }

  private disposeClaudeQuery(): void {
    const client = this.claudeCodeModel as (ModelClient & { dispose?: () => Promise<void> | void }) | undefined
    if (!client?.dispose) return
    try {
      void Promise.resolve(client.dispose()).catch(() => undefined)
    } catch { /* The next SDK request will open a fresh query. */ }
  }

  private handleModelReply(reply: ModelReply, progressEntryId?: string): void {
    this.closeThinkingEntries()
    if (this.state.mode === 'claude_code' && reply.sdkSessionId) this.sdkSessionId = reply.sdkSessionId
    if (reply.compacted) this.add('system', '上下文已自动压缩，可继续当前会话。')
    if (reply.text) {
      this.history.push({ role: 'assistant', content: reply.text })
      if (!reply.timelineHandled) {
        const progressEntry = this.state.timeline.find((entry) => entry.id === progressEntryId)
        if (progressEntry) {
          progressEntry.text = reply.text
          this.markTimelineDirty(progressEntry)
          this.emit()
        } else this.add('assistant', reply.text)
      }
    }
    if (reply.note) {
      this.offerNote(reply.note.title, reply.note.content)
    } else {
      this.state.taskStatus = 'done'
      // 'success', not 'idle': the portrait reads it as "the reply just
      // landed" and raises a smile for a beat. The next turn's sendMessage
      // flips it back to 'thinking'.
      this.state.avatarState = 'success'
      // An ordinary reply does not prove a /goal iteration or a clear.
      if (this.state.goal && (this.state.goal.phase === 'requested' || this.state.goal.phase === 'stopping')) {
        this.state.goal = { ...this.state.goal, phase: 'unverified',
          statusMessage: 'CLI 尚未确认目标状态；可用 /goal 查询或重试清除。' }
      }
      this.emit()
    }
  }

  private recordToolEvent(event: ModelToolEvent, generation: number): void {
    if (generation !== this.generation || !event.toolUseId || !event.toolName) return
    if (event.phase === 'start') this.closeThinkingEntries()
    const existing = this.state.timeline.find((entry) => entry.tool?.toolUseId === event.toolUseId)
    const status = event.phase === 'start' ? 'running' : event.isError ? 'error' : 'done'
    const text = `${toolLabel(event.toolName)}${status === 'running' ? '（执行中）' : status === 'error' ? '（失败）' : '（已完成）'}`
    if (existing) {
      existing.text = text
      existing.tool = { ...existing.tool!, status, input: event.input ?? existing.tool?.input, output: event.output ?? existing.tool?.output }
      this.markTimelineDirty(existing)
    } else {
      const entry: TimelineEntry = {
        id: crypto.randomUUID(), time: new Date().toISOString(), kind: 'tool', text,
        tool: { toolUseId: event.toolUseId, name: event.toolName, status, input: event.input, output: event.output }
      }
      this.state.timeline.push(entry)
      this.markTimelineDirty(entry)
    }
    if (event.phase === 'start') {
      this.state.taskStatus = 'executing'
      this.state.avatarState = 'acting'
    } else if (!this.state.timeline.some((entry) => entry.kind === 'tool' && entry.tool?.status === 'running')) {
      this.state.taskStatus = 'planning'
      this.state.avatarState = 'thinking'
    }
    this.emit()
  }

  private closeThinkingEntries(): void {
    if (!this.thinkingOpen) return
    this.thinkingOpen = false
    const now = new Date().toISOString()
    for (const entry of this.state.timeline) {
      if (entry.kind === 'thinking' && !entry.endedAt) {
        entry.endedAt = now
        this.markTimelineDirty(entry)
      }
    }
  }

  private finishRunningTools(reason: string): void {
    for (const entry of this.state.timeline) {
      if (entry.kind !== 'tool' || entry.tool?.status !== 'running') continue
      entry.tool.status = 'error'
      entry.tool.output ??= reason
      entry.text = `${toolLabel(entry.tool.name)}（${reason}）`
      this.markTimelineDirty(entry)
    }
  }

  private offerNote(title: string, content: string): void {
    try {
      const draft = this.store.makeDraft(title, content)
      this.draft = draft
      const proposal: ProposedAction = {
        id: draft.id,
        tool: 'write_test_note',
        description: '在项目测试目录创建一份新的 Markdown 笔记',
        target: draft.target,
        content: draft.content,
        risk: 'write'
      }
      this.state.proposal = proposal
      this.state.taskStatus = 'awaiting_approval'
      this.state.avatarState = 'thinking'
      this.add('system', '笔记草稿已准备好，请查看路径和内容后决定是否写入。')
    } catch (error) {
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.add('system', error instanceof Error ? error.message : '无法准备笔记草稿。')
    }
  }

  private finishWithText(text: string): void {
    this.history.push({ role: 'assistant', content: text })
    this.state.taskStatus = 'done'
    this.state.avatarState = 'idle'
    this.add('assistant', text)
  }

  private add(kind: TimelineEntry['kind'], text: string, images?: TimelineEntry['images']): TimelineEntry {
    const entry: TimelineEntry = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      kind,
      text,
      ...(images?.length ? { images } : {})
    }
    this.state.timeline.push(entry)
    this.markTimelineDirty(entry)
    this.emit()
    return entry
  }

  /** Records that an entry changed since the last publisher take; the id-keyed
   *  map keeps one (latest) copy per entry. */
  private markTimelineDirty(entry: TimelineEntry): void {
    this.state.timelineRevision += 1
    this.timelineDirty.set(entry.id, entry)
  }

  /**
   * The timeline changes since the publisher last took them. `reset` asks for
   * one full send (first publish of the process, or right after a restore);
   * afterwards only changed entries travel and the renderer upserts them by
   * id. Entries that never changed keep their identity across publishes, which
   * is what lets every memoized row in the panel skip re-rendering.
   */
  takeTimelineDelta(): { reset: boolean; baseRevision: number; revision: number; entries: TimelineEntry[] } {
    const reset = this.timelineSentRevision < 0
    const baseRevision = this.timelineSentRevision
    const entries = reset ? [] : [...this.timelineDirty.values()]
    this.timelineDirty.clear()
    this.timelineSentRevision = this.state.timelineRevision
    return { reset, baseRevision, revision: this.state.timelineRevision, entries }
  }

  /** The publisher's next take must carry the whole timeline — used when a
   *  runtime that has been running (or sitting) in the background becomes the
   *  displayed conversation again. */
  forceFullTimeline(): void {
    this.timelineSentRevision = -1
  }

  /** The CLI's command/skill catalog, when the engine backs this runtime. */
  getCommandCatalog(): { commands: string[]; skills: string[] } | undefined {
    const model = this.claudeCodeModel as (ModelClient & { getCommandCatalog?: () => { commands: string[]; skills: string[] } }) | undefined
    return model?.getCommandCatalog?.()
  }

  /** Charge only when both billed token buckets are known. A bare total is a
   *  real token count but cannot determine the price, so leave it unknown. */
  private accrueSpend(): void {
    const usage = this.state.taskMetrics?.usage
    const finishedAt = this.state.taskMetrics?.finishedAt
    if (!usage || usage.input === undefined || usage.output === undefined || !finishedAt) return
    if (![usage.input, usage.output, usage.cacheRead ?? 0, usage.cacheCreate ?? 0]
      .every((tokens) => Number.isSafeInteger(tokens) && tokens >= 0)) return
    const yuan = usageSpendYuan(usage, Date.parse(finishedAt))
    if (yuan === null || !Number.isFinite(yuan)) return
    const charge = Number(yuan.toFixed(9))
    this.state.taskMetrics!.spentYuan = charge
    this.state.conversationSpentYuan = Number(((this.state.conversationSpentYuan ?? 0) + charge).toFixed(9))
  }

  private emit(): void {
    if (this.state.taskMetrics && !this.state.taskMetrics.finishedAt &&
      ['done', 'failed', 'cancelled'].includes(this.state.taskStatus)) {
      this.state.taskMetrics.finishedAt = new Date().toISOString()
      this.accrueSpend()
      const user = this.state.timeline.find((entry) => entry.id === this.currentTurnUserId && entry.kind === 'user')
      if (user) {
        user.metrics = structuredClone(this.state.taskMetrics)
        this.markTimelineDirty(user)
      }
      this.currentTurnUserId = undefined
    }
    // The consumer pulls a snapshot when it is ready to publish one; building one here
    // would clone the whole timeline on every streaming delta for nothing.
    this.onChange()
  }
}
