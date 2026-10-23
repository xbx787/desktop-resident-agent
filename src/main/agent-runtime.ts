import { normalizeApprovalMode, type AgentCapabilities, type AgentGoal, type ApprovalMode, type AppSnapshot, type AskAnswers, type ContextUsageSnapshot, type EffortLevel, type ModelMode, type ModelProfile, type ProposedAction, type SubagentTask, type TimelineEntry, type ToolPermissionRequest, type UserAttachment } from '../shared/contracts'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { AgentKernel } from './agent-kernel'
import type { EvolveBridge } from './evolve-tools'
import { isImageAttachmentName } from '../shared/image-preview'
import { publicErrorText } from '../shared/error-copy'
import { getPeakStatus, usageSpendYuan } from '../shared/deepseek-pricing'
import { toolLabel } from '../shared/tool-labels'
import { AgentTurnError } from './agent-errors'
import type { DialogueLine, ModelClient, ModelImage, ModelReply, ModelToolEvent } from './deepseek'
import { agentActivityForTool, type AgentActivity } from '../shared/agent-activity'
import type { ConversationRecord } from './conversation-store'
import { NoteStore, type NoteDraft } from './note-store'
import { attachmentContext, expandFileMentions, validAttachmentList } from './local-context'
import type { ConversationBridge, ConversationTarget } from './conversation-tools'

const DEMO_HINT = '演示模式仅支持「记录：内容」的测试笔记流程。'

/** 图片输入的格式与上限；超过上限或读不到时退化为“路径提示”，不阻断发送。 */
const PROMPT_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
const MAX_PROMPT_IMAGES = 4
const MAX_PROMPT_IMAGE_BYTES = 4 * 1024 * 1024

async function readPromptImages(attachments: readonly UserAttachment[]): Promise<ModelImage[]> {
  const images: ModelImage[] = []
  for (const item of attachments) {
    if (images.length >= MAX_PROMPT_IMAGES) break
    if (!item.path || !isImageAttachmentName(item.name)) continue
    const mimeType = PROMPT_IMAGE_MIME[path.extname(item.name).toLowerCase()]
    if (!mimeType) continue
    try {
      const stat = await fs.stat(item.path)
      if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_PROMPT_IMAGE_BYTES) continue
      const data = (await fs.readFile(item.path)).toString('base64')
      images.push({ name: item.name, mimeType, data })
    } catch {
      // 读不到就当没有这张图；附件路径仍会出现在文本提示里。
    }
  }
  return images
}

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
  /** 上一轮的用户消息 id：停止后补到的用量要写回它。 */
  private lastTurnUserId?: string
  private generation = 0
  private contextGeneration = 0
  private sdkSessionId: string | null = null
  private personaId = 'xiaojing'
  private outputStyle?: string
  private appendSystemPrompt?: string
  private loadUserSettings = true
  private personaRevision = 0
  private thinkingOpen = false
  private goalMaxIterations = 30
  /** Deprecated: goals no longer stop on a wall-clock budget. Kept only so old
   *  records and settings still parse. */
  private goalMaxMinutes = 0
  private goalTimer?: ReturnType<typeof setTimeout>
  private queuePauseReason: string | null = null
  private goalSessionInvalidated = false
  /** Kernels without a native goal driver (DSH) run the loop here. */
  private readonly localGoalKernel: boolean
  /** Set when a local goal round ended with work left; send after the turn. */
  private pendingGoalContinuation = false
  /** 插队发送用：DSH 没有原生 steer，只能打断当前回合，队列里的消息随后接上。 */
  private steerInterruptPending = false
  /** 插队消息先压着，等下一次思考开始时再贴到时间线。 */
  private deferredSteer?: { text: string; attachments: UserAttachment[] }
  /** 正在等回显的插话：同一会话同时只允许一条，避免覆盖上一条。 */
  private pendingSteer?: { text: string; messageId?: string; startedAt: string }
  /** The controller's own goal-clear path (interrupt + /goal clear turn). */
  private goalClearHandler?: () => void
  private memoryContextProvider?: () => Promise<string>
  /** Remembers which asking mode to return to when plan mode ends. */
  private lastNonPlanApproval: ApprovalMode = 'workspace-write'
  /** Which conversation this runtime owns; assigned by the controller at creation. */
  conversationId = ''
  /** Entries changed since the publisher's last take (upsert by id). */
  private timelineDirty = new Map<string, TimelineEntry>()
  /** The timeline revision the publisher last reported; -1 = never. */
  private timelineSentRevision = -1

  constructor(
    private readonly store: NoteStore,
    model: AgentKernel | undefined,
    private readonly onChange: () => void = () => {},
    claudeCodeModel?: AgentKernel,
    private readonly workspaceRoot?: string,
    evolveHooks?: Omit<EvolveBridge, 'enabled'>
  ) {
    this.configuredModel = model
    this.claudeCodeModel = claudeCodeModel
    this.model = claudeCodeModel ?? model
    this.localGoalKernel = (claudeCodeModel as { goalMode?: string } | undefined)?.goalMode === 'local'
    claudeCodeModel?.setGoalListener?.((goal) => this.observeGoal(goal))
    claudeCodeModel?.setSteerEchoListener?.((messageId) => this.settleSteerEcho(messageId))
    claudeCodeModel?.setPlanModeListener?.((on) => {
      this.state.planMode = on
      this.emit()
    })
    // The CLI can enter/leave plan mode on its own (EnterPlanMode); mirror it.
    claudeCodeModel?.setApprovalModeListener?.((mode) => {
      this.state.approvalMode = normalizeApprovalMode(mode)
      this.state.planMode = this.state.approvalMode === 'read-only'
      this.emit()
    })
    // A tool call parked in default/acceptEdits mode. While any interaction
    // waits on the user the task is awaiting approval, not executing.
    claudeCodeModel?.setPermissionListener?.((permission) => {
      this.state.permission = permission
      this.syncApprovalWait()
      this.emit()
    })
    // Automatic compaction: the CLI decides by itself at the threshold. Only
    // the auto flag is handled here; a manual compact owns the same state via
    // compactContext().
    claudeCodeModel?.setCompactingListener?.((state) => {
      this.state.contextCompacting = state.active
      this.state.contextCompactingAuto = state.active && state.auto
      this.emit()
    })
    // A parked AskUserQuestion lives in the snapshot while the panel shows it.
    claudeCodeModel?.setQuestionListener?.((question) => {
      this.state.question = question;
      this.syncApprovalWait();
      this.emit();
    });
    // A parked ExitPlanMode lives there too until the plan is approved or sent back.
    claudeCodeModel?.setPlanListener?.((plan) => {
      this.state.plan = plan;
      if (plan) this.state.approvedPlan = undefined;
      this.syncApprovalWait();
      this.emit();
    });
    // Task-tool subagents; the SDK client throttles progress to 2 s.
    claudeCodeModel?.setSubagentTasksListener?.((tasks) => {
      this.state.subagents = tasks;
      this.emit();
    });
    this.state = {
      mode: claudeCodeModel ? 'claude_code' : model ? 'live' : 'demo',
      modelReady: Boolean(model),
      claudeCodeReady: Boolean(claudeCodeModel),
      avatarState: 'idle',
      taskStatus: 'idle',
      effort: 'max',
      approvalMode: 'workspace-write',
      permission: null,
      contextCompactingAuto: false,
      timeline: [],
      subagents: [],
      subagentControls: Boolean(claudeCodeModel && (
        typeof (claudeCodeModel as { backgroundTask?: unknown }).backgroundTask === 'function' ||
        typeof (claudeCodeModel as { stopTask?: unknown }).stopTask === 'function'
      )),
      timelineRevision: 0
    }
    // The tools stay registered for the runtime's lifetime; only the approval
    // tier decides whether they do anything.
    if (claudeCodeModel && evolveHooks) {
      claudeCodeModel.setEvolveBridge?.({
        ...evolveHooks,
        enabled: () => this.state.approvalMode === 'selfEvolve'
      })
    }
  }

  setModelMode(mode: ModelMode, silent = false): void {
    if (this.isRunning()) throw new Error('任务进行中时不能切换模型。')
    if (mode === 'live' && !this.configuredModel) throw new Error('尚未配置 DeepSeek API Key。')
    if (mode === 'claude_code' && !this.claudeCodeModel) throw new Error('小鲸引擎或 DeepSeek API Key 尚未就绪。')
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
    this.markContextUsageStale()
    this.state.taskMetrics = undefined
    this.state.modelReady = Boolean(this.configuredModel)
    if (silent) this.emit()
    else this.add('system', mode === 'claude_code' ? '已切换到小鲸引擎 + DeepSeek。' : mode === 'live' ? '已切换到 DeepSeek Flash。' : '已切换到演示模式。')
  }

  /** Memory is added only to the model request copy, never to the visible or saved history. */
  setMemoryContextProvider(provider?: () => Promise<string>): void {
    this.memoryContextProvider = provider
  }

  /** Starts an ephemeral child with a copy of settled model dialogue only.
   * Visible entries and, crucially, the parent's SDK session ID are not copied. */
  seedHistory(history: readonly DialogueLine[]): void {
    if (this.isRunning() || this.state.timeline.length || this.history.length) {
      throw new Error('只能给新的临时对话设置历史。')
    }
    this.history.push(...structuredClone(history))
    this.sdkSessionId = null
  }

  /** Planned-first sessions: research and propose before touching anything. */
  async setPlanMode(on: boolean): Promise<void> {
    await this.setApprovalMode(on ? 'read-only' : this.lastNonPlanApproval)
  }

  /** Claude Code's permission modes, switched through the query's control
   *  channel. A cold query records the choice for the next session. */
  async setApprovalMode(mode: ApprovalMode): Promise<void> {
    if ((this.state.approvalMode ?? 'workspace-write') === mode) return
    const client = this.claudeCodeModel
    // Older clients (and test doubles) only know the plan switch.
    const fallbackToPlan = !client?.setApprovalMode && Boolean(client?.setPlanMode) &&
      (mode === 'read-only' || mode === 'danger-full-access')
    if (this.state.mode !== 'claude_code' || !client || (!client.setApprovalMode && !fallbackToPlan)) {
      throw new Error('当前模型不支持审批模式。')
    }
    try {
      const confirmed = client.setApprovalMode ? await client.setApprovalMode(mode) : await client.setPlanMode?.(mode === 'read-only')
      if (confirmed === false) {
        // Cold query: the choice only shows once the SDK's init confirms it.
        return
      }
    } catch {
      this.addSystem('审批模式切换失败，SDK 未确认。', 'error')
      throw new Error('审批模式切换失败，SDK 未确认。')
    }
    // Switch silently: the button already shows the new mode, and a system
    // line for every flip buried the conversation it was supposed to explain.
    this.state.approvalMode = mode
    this.state.planMode = mode === 'read-only'
    if (mode !== 'read-only') this.lastNonPlanApproval = mode
    this.emit()
  }

  /** Forwards the panel's allow/deny to the model that parked the call. */
  async answerPermission(id: string, allow: boolean): Promise<void> {
    const model = this.model as (ModelClient & { answerPermission?: (id: string, allow: boolean) => boolean }) | undefined
    if (!model?.answerPermission) throw new Error('当前没有等待批准的操作。')
    if (!model.answerPermission(id, allow)) throw new Error('这次操作已经失效。')
  }

  /** The controller owns the only path that clears a goal: interrupt the loop
   *  turn, then send /goal clear as a queued turn of its own. */
  setGoalClearHandler(handler?: () => void): void {
    this.goalClearHandler = handler
  }

  /** Wires the conversations MCP tools; the source id is this runtime's own. */
  setConversationBridge(bridge?: {
    list: () => ConversationTarget[]
    send: (target: string, text: string, sourceConversationId: string) => Promise<{ id: string; title: string }>
  }): void {
    const model = this.claudeCodeModel as (ModelClient & { setConversationBridge?: (bridge?: ConversationBridge) => void }) | undefined
    if (!model?.setConversationBridge) return
    model.setConversationBridge(bridge ? {
      list: bridge.list,
      send: (target, text) => bridge.send(target, text, this.conversationId)
    } : undefined)
  }

  /** Moves a blocking subagent to the background so the main turn continues. */
  async backgroundSubagent(toolUseId: string): Promise<boolean> {
    const model = this.model as (ModelClient & { backgroundTask?: (toolUseId?: string) => Promise<boolean> }) | undefined
    if (!model?.backgroundTask) throw new Error('当前模型不支持后台运行子代理。')
    return model.backgroundTask(toolUseId)
  }

  /** A foreground subagent blocks the main turn. When the user sends
   *  anything, move every foreground subagent to the background first so the
   *  message is handled now instead of waiting for the child to finish. */
  async releaseForegroundSubagents(): Promise<void> {
    const blocked = (this.state.subagents ?? []).some((task) => task.status === 'running' && !task.isBackgrounded)
    if (!blocked) return
    const model = this.model as (ModelClient & { backgroundTask?: (toolUseId?: string) => Promise<boolean> }) | undefined
    if (!model?.backgroundTask) return
    // No tool id means "all foreground tasks", the SDK's Ctrl+B.
    await model.backgroundTask()
  }

  /** Stops one Task-tool subagent. */
  async stopSubagent(taskId: string): Promise<void> {
    const model = this.model as (ModelClient & { stopTask?: (taskId: string) => Promise<void> }) | undefined
    if (!model?.stopTask) throw new Error('当前模型不支持停止子代理。')
    await model.stopTask(taskId)
  }

  /** The SDK has no host-side send-to-child control (live-tested: a message
   *  tagged with parent_tool_use_id is consumed by the main turn). The honest
   *  path is a steer to the main turn: it can relay via SendMessage when the
   *  tool is available, or act on the information itself. */
  async messageSubagent(toolUseId: string, text: string): Promise<boolean> {
    const clean = text.trim()
    if (!clean) return false
    const task = (this.state.subagents ?? []).find((item) => item.toolUseId === toolUseId)
    // A foreground child blocks the turn; release it before the steer.
    await this.releaseForegroundSubagents().catch(() => undefined)
    const instruction = [
      `用户要转达给正在运行的子代理「${task?.description ?? toolUseId}」：`,
      clean,
      '如果 SendMessage 工具可用，请把这条内容发给该子代理；否则在当前任务里处理这条信息。'
    ].join('\n')
    return this.steerMessage(instruction)
  }

  setGoalBudget(maxIterations: number, maxMinutes: number): void {
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1 || maxIterations > 300 ||
        !Number.isSafeInteger(maxMinutes) || maxMinutes < 0 || maxMinutes > 1440) {
      throw new Error('目标预算必须在允许范围内。')
    }
    if (this.goalMaxIterations === maxIterations && this.goalMaxMinutes === maxMinutes) return
    this.goalMaxIterations = maxIterations
    this.goalMaxMinutes = maxMinutes
    // Time limits are no longer enforced; the iteration budget remains.
    this.clearGoalTimer()
    this.checkGoalBudget()
  }

  /** The goal alone, without cloning a snapshot — the controller checks it on
   *  every change tick and a full clone is far too heavy for that. */
  getGoal(): AgentGoal | null { return this.state.goal ?? null }

  getQueuePauseReason(): string | null { return this.queuePauseReason }

  resumeQueue(): void { this.queuePauseReason = null }

  /** A requested goal is only a local request until an SDK event confirms it. */
  private trackGoal(text: string): void {
    const match = /^\/goal(?:\s+([\s\S]+))?$/iu.exec(text.trim())
    if (!match) return
    // A new explicit goal query belongs to the replacement SDK session.
    this.goalSessionInvalidated = false
    const condition = match?.[1]?.trim() ?? ''
    if (!condition) return // Bare /goal just asks the CLI for its state.
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

  /** DSH has no native goal driver, so `/goal` becomes a local loop: the
   *  first prompt carries the objective, each finished round increments the
   *  counter, and the model ends the goal with a `[[GOAL_DONE]]` marker. */
  private trackLocalGoal(text: string): string | 'handled' | null {
    const match = /^\/goal(?:\s+([\s\S]+))?$/iu.exec(text.trim())
    if (!match) return null
    const condition = match[1]?.trim() ?? ''
    if (!condition) {
      this.add('system', this.state.goal
        ? `当前目标：${this.state.goal.condition}\n已推进 ${this.state.goal.iterations ?? 0} 轮，没有轮数上限。`
        : '当前没有目标。用法：/goal 目标条件。')
      return 'handled'
    }
    if (/^clear$/iu.test(condition)) {
      this.state.goal = null
      this.pendingGoalContinuation = false
      this.queuePauseReason = null
      this.add('system', '已清除目标。')
      this.emit()
      return 'handled'
    }
    this.goalSessionInvalidated = false
    this.state.goal = {
      condition,
      phase: 'confirmed',
      startedAt: new Date().toISOString(),
      iterations: 0
    }
    this.emit()
    return this.goalPrompt(condition, false)
  }

  private goalPrompt(condition: string, continuation: boolean): string {
    const lead = continuation ? `继续执行目标：${condition}` : `目标：${condition}`
    return [
      lead,
      '',
      '（目标模式：持续执行直到目标完成。每轮结束时，如果目标已经完成，在最终回复的最后单独一行写 [[GOAL_DONE]]；否则继续执行下一步，不要停下来询问确认。目标未完成时不要写这个标记。）'
    ].join('\n')
  }

  private observeGoal(goal: AgentGoal | null): void {
    if (this.goalSessionInvalidated) return
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
      ...(goal.lastReason ? { lastReason: goal.lastReason } : {}),
      ...(goal.iterations === undefined ? { statusMessage: 'CLI 未提供轮数。' } : {}) }
    this.emit()
    this.checkGoalBudget()
  }

  private clearGoalTimer(): void {
    if (this.goalTimer) clearTimeout(this.goalTimer)
    this.goalTimer = undefined
  }

  private armGoalTimer(): void {
    // Goals are bounded by iterations, not wall-clock time. Keep the method so
    // old call sites remain, but never arm a stop timer.
    this.clearGoalTimer()
  }

  private checkGoalBudget(): void {
    // 目标没有轮数或时间上限：只以模型的 [[GOAL_DONE]] 或用户停止结束。
    const goal = this.state.goal
    if (!goal || this.queuePauseReason) return
  }

  /** Stop alone leaves the CLI's goal armed, so the next message would resume
   *  the same loop. Budget exhaustion also clears the goal through the
   *  controller's own /goal clear path. */
  private exceedGoalBudget(reason: string): void {
    if (this.localGoalKernel) {
      this.state.goal = null
      this.pendingGoalContinuation = false
      this.add('system', reason)
      this.stop()
      this.emit()
      return
    }
    this.stop(reason)
    try { this.goalClearHandler?.() } catch { /* stop already paused the queue */ }
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
    const capabilities = this.getCapabilities()
    return {
      ...structuredClone(rest),
      ...(Object.keys(capabilities).length ? { capabilities } : {}),
      ...(this.workspaceRoot ? { workspace: this.workspaceRoot } : {}),
      timeline,
      // Pause state lives outside the cloned snapshot: it changes with the
      // controller's queue, not with the conversation record.
      ...(this.queuePauseReason ? { queuePauseReason: this.queuePauseReason } : {})
    }
  }

  /** 当前内核握手后确认的能力；还不知道时返回空对象。 */
  getCapabilities(): AgentCapabilities {
    const model = this.model as (ModelClient & { imageInputSupport?: () => boolean | undefined }) | undefined
    const imageInput = model?.imageInputSupport?.()
    return imageInput === undefined ? {} : { imageInput }
  }

  /** 会话上下文要重建时，不把上一次真实读数抹掉，只标成旧值。 */
  private markContextUsageStale(): void {
    const current = this.state.contextUsage
    this.state.contextUsage = current?.status === 'available'
      ? { ...current, stale: true }
      : { status: 'unavailable' }
  }

  async getContextUsage(): Promise<ContextUsageSnapshot> {
    const model = this.model as (ModelClient & { getContextUsage?: (sessionId?: string | null) => Promise<ContextUsageSnapshot> }) | undefined
    const current = this.state.contextUsage
    if (this.state.mode !== 'claude_code' || !model?.getContextUsage) {
      return current?.status === 'available'
        ? { ...structuredClone(current), stale: true }
        : { status: 'unavailable' }
    }
    const generation = this.contextGeneration
    const sessionId = this.sdkSessionId
    let usage: ContextUsageSnapshot
    try {
      usage = await model.getContextUsage(sessionId)
    } catch {
      usage = { status: 'unavailable' }
    }
    if (generation !== this.contextGeneration || this.state.mode !== 'claude_code' || sessionId !== this.sdkSessionId) {
      return current?.status === 'available'
        ? { ...structuredClone(current), stale: true }
        : { status: 'unavailable' }
    }
    // A cold DSH session has no live usage yet; keep the persisted reading
    // instead of replacing it with "unknown". It is marked stale so the UI can
    // say it is the last known value.
    if (usage.status !== 'available' && current?.status === 'available') {
      this.state.contextUsage = { ...current, stale: true }
      this.emit()
      return structuredClone(this.state.contextUsage)
    }
    this.state.contextUsage = { ...usage, stale: false, checkedAt: new Date().toISOString() }
    this.emit()
    return structuredClone(this.state.contextUsage)
  }

  async compactConversation(): Promise<void> {
    if (this.isRunning()) throw new Error('当前任务完成后才能手动压缩上下文。')
    const model = this.model as (ModelClient & { compact?: (sessionId?: string | null) => Promise<ContextUsageSnapshot> }) | undefined
    if (this.state.mode !== 'claude_code' || !model?.compact) throw new Error('当前模型不支持手动压缩。')
    this.state.contextCompacting = true
    this.state.contextCompactingAuto = false
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
      this.state.contextCompactingAuto = false
      this.emit()
    }
  }

  isRunning(): boolean {
    return this.isBusy() || Boolean(this.state.contextCompacting)
  }

  /** Adds guidance to the active SDK turn at its next native execution boundary. */
  async steerMessage(rawText: string, attachments: UserAttachment[] = [], sessionContext = ''): Promise<boolean> {
    if (!this.isBusy() || this.state.mode !== 'claude_code') return false
    // 一次只允许一条待确认的插话。但回显可能一直不来（或 id 对不上），
    // 不能让一次插话把整轮锁死：消息已经贴回时间线，或等满 20 秒，就放行。
    if (this.pendingSteer) {
      if (Date.now() - Date.parse(this.pendingSteer.startedAt) < 20_000) return false
      this.pendingSteer = undefined
    }
    const generation = this.generation
    if (!validAttachmentList(attachments)) return false
    const text = rawText.trim()
    const context = attachmentContext(attachments)
    const prompt = [text, context].filter(Boolean).join('\n\n')
    if (!prompt || prompt.length > 8_000) return false
    const model = this.model as (ModelClient & {
      steer?: (text: string) => Promise<boolean | { accepted: boolean; messageId?: string }> | boolean | { accepted: boolean; messageId?: string }
    }) | undefined
    if (!model?.steer) return false
    const expandedText = this.workspaceRoot
      ? await expandFileMentions(text, this.workspaceRoot, { maxFileBytes: 32 * 1024, maxTotalBytes: 48 * 1024 })
      : { prompt: text }
    if (generation !== this.generation || !this.isBusy()) return false
    const expandedPrompt = [expandedText.prompt, context, sessionContext].filter(Boolean).join('\n\n')
    let outcome: boolean | { accepted: boolean; messageId?: string }
    try {
      outcome = await model.steer(expandedPrompt)
    } catch {
      // 无法确认投递：不重发，交给调用方退回队列。
      this.addSystem('插话投递未能确认，消息已退回待发送队列。', 'error')
      return false
    }
    if (generation !== this.generation || !this.isBusy()) return false
    const accepted = typeof outcome === 'boolean' ? outcome : outcome.accepted
    if (!accepted) {
      this.addSystem('插话未能投递，消息已退回待发送队列。', 'error')
      return false
    }
    this.history.push({ role: 'user', content: prompt, ...(sessionContext ? { sessionContext } : {}) })
    // 插队消息先压着：等模型下一次思考开始时再贴到时间线，视觉上就是
    // “用户说完，第二条思考马上接上”。投递本身仍然是即时的。
    this.deferredSteer = { text, attachments }
    // 消息已投递给模型、还没轮到显示：队列区先挂一条“正在插话”。
    const startedAt = new Date().toISOString()
    this.pendingSteer = {
      text,
      startedAt,
      ...(typeof outcome === 'object' && outcome.messageId ? { messageId: outcome.messageId } : {})
    }
    this.state.steering = { text: text.slice(0, 80), startedAt }
    this.emit()
    return true
  }

  /** DSH 把 steer 的用户消息写进会话后回显；收到后结束待确认状态。 */
  private settleSteerEcho(messageId: string): void {
    const pending = this.pendingSteer
    if (!pending) return
    if (pending.messageId !== undefined && messageId !== undefined && pending.messageId !== messageId) return
    this.pendingSteer = undefined
    this.emit()
  }

  /** 把压着的插队消息贴回时间线（在下一段思考开始之前）。 */
  private flushDeferredSteer(): void {
    const pending = this.deferredSteer
    if (!pending) return
    this.deferredSteer = undefined
    // 已经贴回时间线，说明这一句真的进了回合：可以接受下一次插话了。
    this.pendingSteer = undefined
    this.state.steering = undefined
    const { text, attachments } = pending
    const steered = this.add('user', attachments.length ? `${text || '请阅读附件并帮助我。'}\n附件：${attachments.map(({ name }) => name).join('、')}` : text, messageImages(attachments))
    steered.interrupted = true
    this.markTimelineDirty(steered)
  }

  /** DSH 内核没有“往当前任务里注入一句话”的能力，插队只能取消这一轮：
   *  调用方先把消息插到队列最前，这里发出打断，回合结束后 drain 立刻发它。
   *  返回 true 表示打断已发出；没有可打断的回合时返回 false。 */
  async steerInterrupt(): Promise<boolean> {
    if (!this.isBusy()) return false
    const model = this.model as (ModelClient & { interrupt?: () => Promise<void> | void }) | undefined
    if (!model?.interrupt) return false
    this.steerInterruptPending = true
    try {
      await model.interrupt()
    } catch {
      this.steerInterruptPending = false
      return false
    }
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
    this.state.subagents = []
    this.state.approvedPlan = undefined
    // 重开应用/切换会话时先显示上次真实读到的用量；下一次 usage_update
    // 会覆盖它，不会把“未记录”一直挂在界面上。
    this.state.contextUsage = record.contextUsage ?? { status: 'unavailable' }
    this.state.contextCompacting = false
    this.state.contextCompactingAuto = false
    this.state.taskMetrics = undefined
    this.state.conversationSpentYuan = typeof record.spentYuan === 'number' && Number.isFinite(record.spentYuan) && record.spentYuan >= 0
      ? record.spentYuan : undefined
    this.currentTurnUserId = undefined
    // A restored CLI goal is visible, but its state must be confirmed again by
    // an SDK event before we call it active or count another iteration.
    this.clearGoalTimer()
    this.state.goal = record.goal
      ? this.localGoalKernel
        ? { ...record.goal, phase: 'confirmed' }
        : { ...record.goal, phase: 'unverified', statusMessage: '会话恢复后尚未收到 CLI 目标状态确认。' }
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
    // The approval mode survives the restart: the client records the preference
    // and builds the next query with it; the CLI re-reports the real state on
    // init. Records written before the mode existed fall back to planMode.
    const savedMode: ApprovalMode = normalizeApprovalMode(
      record.approvalMode ?? (record.planMode ? 'plan' : undefined)
    )
    this.state.approvalMode = savedMode
    this.state.planMode = savedMode === 'read-only'
    if (savedMode !== 'read-only') this.lastNonPlanApproval = savedMode
    if (mode === 'claude_code' && savedMode !== 'danger-full-access') {
      void Promise.resolve(this.claudeCodeModel?.setApprovalMode?.(savedMode)).catch(() => undefined)
    }

    if (mode !== 'claude_code') this.state.goal = null
    else this.armGoalTimer()
    this.emit()
  }

  exportConversationState(): Pick<ConversationRecord, 'mode' | 'timeline' | 'history' | 'sdkSessionId' | 'spentYuan' | 'contextUsage' | 'goal' | 'planMode' | 'approvalMode'> {
    return {
      mode: this.state.mode,
      timeline: structuredClone(this.state.timeline),
      history: structuredClone(this.history),
      sdkSessionId: this.sdkSessionId,
      spentYuan: this.state.conversationSpentYuan,
      // 上下文用量随会话保存：打开已有会话时先显示上次的真实读数。
      contextUsage: this.state.contextUsage,
      // All three survive a restart: the goal comes back as "unverified" until
      // the CLI re-confirms it; the approval mode is what the next query is
      // built with, and planMode stays for records from before it existed.
      goal: this.state.goal,
      planMode: this.state.planMode,
      approvalMode: this.state.approvalMode ?? 'workspace-write'
    }
  }

  async sendMessage(rawText: string, attachments: UserAttachment[] = [], sessionContext = '', displayText?: string, hiddenUser = false, divider = false): Promise<void> {
    const text = rawText.trim()
    if (!validAttachmentList(attachments)) {
      this.addSystem('附件数量或大小超过限制。', 'error')
      return
    }
    if (this.state.mode !== 'claude_code' && attachments.some((item) => item.path && !item.content)) {
      this.addSystem('当前模型没有本地文件读取工具。请切换到小鲸引擎模式后再发送此文件。', 'error')
      return
    }
    const context = attachmentContext(attachments)
    let prompt = [text, context].filter(Boolean).join('\n\n')
    if (!prompt) return
    if (this.state.mode === 'claude_code' && this.localGoalKernel) {
      const localGoal = this.trackLocalGoal(text)
      if (localGoal === 'handled') return
      if (localGoal) prompt = [localGoal, context].filter(Boolean).join('\n\n')
    }
    if (prompt.length > 8_000) {
      this.addSystem('单条消息目前最多 8000 字。', 'error')
      return
    }
    if (this.isRunning()) {
      this.add('system', '当前任务尚未结束；请先处理待批准操作，或按“停止”。')
      return
    }

    const goalBeforeRef = this.state.goal
    const goalBefore = goalBeforeRef ? structuredClone(goalBeforeRef) : null
    if (this.state.mode === 'claude_code' && !this.localGoalKernel) this.trackGoal(text)
    const goalChanged = this.state.goal !== goalBeforeRef
    const goalTracked = this.state.goal
    this.generation += 1
    const currentGeneration = this.generation
    this.draft = undefined
    this.state.proposal = undefined
    this.state.approvedPlan = undefined
    this.state.currentTask = (text || `阅读附件：${attachments.map(({ name }) => name).join('、')}`).slice(0, 140)
    this.state.taskMetrics = { startedAt: new Date().toISOString() }
    this.state.taskStatus = 'planning'
    this.state.avatarState = 'thinking'
    this.state.agentActivity = undefined
    this.history.push({ role: 'user', content: prompt, ...(sessionContext ? { sessionContext } : {}) })
    this.currentTurnUserId = hiddenUser
      // 目标续轮不新增可见条目：挂到最近一次用户轮次下，整段连续工作只保留
      // 重启恢复时的那一条「继续执行目标」，它会随着后续消息自然上移。
      ? (() => {
        const timeline = this.state.timeline
        for (let index = timeline.length - 1; index >= 0; index -= 1) {
          if (timeline[index].kind === 'user') return timeline[index].id
        }
        return this.add('system', '已重启，继续执行目标').id
      })()
      : (() => {
        const entry = this.add('user', displayText ?? (attachments.length ? `${text || '请阅读附件并帮助我。'}\n附件：${attachments.map(({ name }) => name).join('、')}` : text), messageImages(attachments))
        if (divider) {
          entry.divider = true
          this.markTimelineDirty(entry)
        }
        return entry.id
      })()

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
      const personaRevision = this.personaRevision
      // 没有图片附件时不要多一个 await，保持原本的同步时序。
      const hasImageAttachment = attachments.some((item) => item.path && isImageAttachmentName(item.name))
      const promptImages = hasImageAttachment ? await readPromptImages(attachments) : []
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
        if (!this.state.taskMetrics) return
        const live = currentGeneration === this.generation
        // 停止之后 DSH 才把最后一笔用量落盘：也要补到刚结束的那一轮，
        // 否则界面会一直显示“用量未记录”。
        if (!live && this.state.taskStatus !== 'cancelled') return
        this.state.taskMetrics.usedTokens = usage.total
        this.state.taskMetrics.usage = usage
        if (!live) {
          const user = this.state.timeline.find((entry) => entry.id === this.lastTurnUserId && entry.kind === 'user')
          if (user) {
            user.metrics = structuredClone(this.state.taskMetrics)
            this.markTimelineDirty(user)
          }
        }
        this.emit()
      }, (partial, segment) => {
        if (currentGeneration !== this.generation || !partial) return
        if (segment !== thinkingSegment) {
          thinkingSegment = segment
          thinkingEntryId = undefined
        }
        if (!thinkingEntryId) {
          if (this.deferredSteer) this.flushDeferredSteer()
          this.closeThinkingEntries()
          thinkingEntryId = crypto.randomUUID()
          // 第一段思考从回合开始（还在“正在理解你的需求”那一刻）算起，
          // 把理解需求的时间也计入思考时长；之后的思考段各从自己开始。
          const firstThought = !this.state.timeline.some((item) => item.kind === 'thinking')
          const startedAt = firstThought ? (this.state.taskMetrics?.startedAt ?? new Date().toISOString()) : new Date().toISOString()
          const entry: TimelineEntry = { id: thinkingEntryId, time: startedAt, kind: 'thinking', text: partial }
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
      }, promptImages)
      if (currentGeneration !== this.generation) return
      this.handleModelReply(reply, progressEntryId)
      // A persona changed during this turn. Its result belongs to the old
      // query, so never resume that SDK session under the new persona.
      if (personaRevision !== this.personaRevision) this.sdkSessionId = null
      else if (this.state.mode === 'claude_code') await this.getContextUsage().catch(() => undefined)
    } catch (error) {
      if (currentGeneration !== this.generation) return
      // A goal typed into this failed send never reached the CLI: restore the
      // previous goal instead of leaving a ghost the user never set.
      if (goalChanged && this.state.goal === goalTracked) this.state.goal = goalBefore
      // A failure that invalidates the resume id must not be remembered for
      // the next turn; the local history replays it into a fresh session.
      const failure = error instanceof AgentTurnError ? error.failure : undefined
      if (failure?.invalidatesSession) this.sdkSessionId = null
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.closeThinkingEntries()
      this.finishRunningTools('未完成')
      this.addSystem(error instanceof Error ? publicErrorText(error.message) : '模型请求失败。', 'error')
    } finally {
      if (currentGeneration === this.generation) this.activeRequest = undefined
    }
    if (currentGeneration === this.generation && this.pendingGoalContinuation) {
      this.pendingGoalContinuation = false
      this.scheduleGoalContinuation()
    }
  }

  /** Sends the next local goal round after the current turn has fully settled.
   *  A zero-delay timer keeps the recursive send off this call stack. */
  private scheduleGoalContinuation(): void {
    const goal = this.state.goal
    if (!goal || goal.phase === 'stopping' || this.queuePauseReason) return
    setTimeout(() => {
      const current = this.state.goal
      if (!current || current.phase === 'stopping' || this.queuePauseReason) return
      if (this.isBusy()) return
      void this.sendMessage(this.goalPrompt(current.condition, true), [], '', undefined, true)
        .catch((error: unknown) => {
          this.addSystem(error instanceof Error ? error.message : '目标继续失败。', 'error')
        })
    }, 0)
  }

  async approveAction(id: string): Promise<void> {
    if (this.state.taskStatus !== 'awaiting_approval' || !this.draft || this.draft.id !== id) {
      this.addSystem('这项操作已经失效，未执行写入。', 'error')
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
      this.addSystem(error instanceof Error ? publicErrorText(error.message) : '测试笔记写入失败。', 'error')
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
    const model = this.model as (ModelClient & { answerQuestion?: (id: string, answers: AskAnswers | null) => boolean | Promise<boolean> }) | undefined
    if (!model?.answerQuestion) throw new Error('当前没有等待回答的问题。')
    if (!await model.answerQuestion(id, answers)) throw new Error('这个问题已经失效。')
  }

  /** Forwards the panel's verdict on a parked plan to the model that asked. */
  async answerPlan(id: string, approved: boolean): Promise<void> {
    const model = this.model as (ModelClient & { answerPlan?: (id: string, approved: boolean) => boolean }) | undefined
    if (!model?.answerPlan) throw new Error('当前没有等待批准的计划。')
    const parked = this.state.plan
    if (!model.answerPlan(id, approved)) throw new Error('这个计划已经失效。')
    // Keep the approved plan for the task strip: the SDK's task list is the
    // live view, but a plan approved without TaskCreate still has steps worth
    // showing while it is implemented.
    if (approved && parked?.id === id) {
      this.state.approvedPlan = parked.plan.slice(0, 4_000)
      this.emit()
    }
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
  /** 开关联网搜索。关闭时 Claude 客户端会把搜索/抓取工具从工具列表移除，
   *  并在人设里明确写明不可搜索。 */
  setWebSearch(on: boolean): void {
    this.claudeCodeModel?.setWebSearchEnabled?.(on)
  }

  /** 自动压缩阈值（百分比）；随下一次 query 与发送前的预算检查生效。 */
  setAutoCompactPercent(percent: number): void {
    this.claudeCodeModel?.setAutoCompactPercent?.(percent)
  }

  /** 本对话用 @ 添加的库；下一次 query 生效。 */
  setLibraries(mcpServers: Record<string, unknown>, plugins: string[]): void {
    const clients = new Set([this.model, this.claudeCodeModel, this.configuredModel])
    for (const client of clients) client?.setLibraries?.(mcpServers, plugins)
  }

  /** Switch the instructions on both model paths. An old SDK transcript also
   * carries its old system prompt, so the next turn must start a fresh query
   * with bounded dialogue replay instead of resuming that transcript. */
  setPersona(id: string): void {
    if (this.personaId === id) return
    this.personaId = id
    this.personaRevision += 1
    this.claudeCodeModel?.setPersonaId?.(id)
    this.configuredModel?.setPersonaId?.(id)
    this.contextGeneration += 1
    this.sdkSessionId = null
    this.markContextUsageStale()
    if (this.state.goal) {
      this.goalSessionInvalidated = true
      this.state.goal = { ...this.state.goal, phase: 'unverified',
        statusMessage: '已切换人设；原模型会话的目标状态无法继承，请重新设定目标。' }
      this.clearGoalTimer()
      this.queuePauseReason = '已切换人设；待发送消息保留，请重新设定目标后继续。'
    }
    this.emit()
  }

  setIdentity(identity: { userName: string; assistantName: string }): void {
    this.claudeCodeModel?.setIdentity?.(identity)
    this.configuredModel?.setIdentity?.(identity)
  }

  /** Prompt-shaping settings restored with a runtime. They update the client
   *  but must not discard a resumed SDK session. */
  syncPromptSettings(outputStyle?: string, appendSystemPrompt?: string, loadUserSettings = true): void {
    this.outputStyle = outputStyle?.trim() || undefined
    this.appendSystemPrompt = appendSystemPrompt?.trim() || undefined
    this.loadUserSettings = loadUserSettings
    this.claudeCodeModel?.setOutputStyle?.(this.outputStyle)
    this.claudeCodeModel?.setAppendSystemPrompt?.(this.appendSystemPrompt)
    this.claudeCodeModel?.setLoadUserSettings?.(loadUserSettings)
  }

  /** Whether the CLI reads ~/.claude settings. No session invalidation: the
   *  client rebuilds its next query on its own. */
  setLoadUserSettings(on: boolean): void {
    if (this.loadUserSettings === on) return
    this.loadUserSettings = on
    this.claudeCodeModel?.setLoadUserSettings?.(on)
  }

  /** A user change to the response style or extra instructions. The CLI
   *  records the system prompt on a session's first request and keeps it on
   *  resume, so the next turn must start a fresh session to see the change. */
  setOutputStyle(style?: string): void {
    const next = style?.trim() || undefined
    if (this.outputStyle === next) return
    this.outputStyle = next
    this.claudeCodeModel?.setOutputStyle?.(next)
    this.invalidateSdkPrompt()
  }

  setAppendSystemPrompt(text?: string): void {
    const next = text?.trim() || undefined
    if (this.appendSystemPrompt === next) return
    this.appendSystemPrompt = next
    this.claudeCodeModel?.setAppendSystemPrompt?.(next)
    this.invalidateSdkPrompt()
  }

  private invalidateSdkPrompt(): void {
    this.contextGeneration += 1
    this.sdkSessionId = null
    this.markContextUsageStale()
    this.emit()
  }

  /** `silent` is for app quit/restart: it stops the turn and keeps the
   *  transcript, but writes no "已停止思考" notice — closing the app should
   *  not look like the user stopped the task. */
  stop(reason?: string, silent = false): void {
    if (this.state.mode !== 'claude_code' && (this.state.taskStatus === 'executing' || this.state.taskStatus === 'verifying')) {
      if (!silent) this.add('system', '写入已经开始，当前步骤会完成读回验证；不会继续执行其他动作。')
      return
    }
    if (!this.isBusy() && !this.state.goal) return
    // 停止时把还没露面的插话消息贴出来，别让它悄悄丢掉。
    this.flushDeferredSteer()
    this.pendingSteer = undefined
    if (this.state.goal) {
      this.pendingGoalContinuation = false
      this.state.goal = this.localGoalKernel
        ? { ...this.state.goal, phase: 'confirmed', statusMessage: reason ?? '目标已暂停；发送新消息可继续。' }
        : { ...this.state.goal, phase: 'unverified',
            statusMessage: reason ?? '已请求停止，但 CLI 尚未确认目标清除；可用 /goal 查询。' }
      this.clearGoalTimer()
      if (!silent) this.queuePauseReason = reason ?? '任务已停止；待发送消息仍保留，发送新消息可继续。'
    }
    if (!this.isBusy()) {
      if (!silent) this.add('system', reason ?? '已请求停止目标；CLI 状态尚未确认。')
      return
    }
    this.generation += 1
    // 停止前把已经建好的模型会话记下来：否则这条记录没有 session id，
    // 下一条消息会新开一个空会话，模型就丢了上下文。
    const liveSession = (this.model as (ModelClient & { currentSessionId?: () => string | null }) | undefined)?.currentSessionId?.()
    if (liveSession) this.sdkSessionId = liveSession
    this.activeRequest?.abort()
    this.activeRequest = undefined
    // Stop interrupts the running turn only; the CLI session stays resumable
    // so the next message still remembers the conversation so far.
    this.draft = undefined
    this.state.proposal = undefined
    this.state.question = null
    this.state.plan = null
    this.state.taskStatus = silent ? 'idle' : 'cancelled'
    this.state.avatarState = 'idle'
    this.closeThinkingEntries()
    if (silent) this.dropRunningTools()
    else this.finishRunningTools('已停止')
    if (!silent) {
      // 不再写「已停止思考」：停止本身就是结果，不需要再补一句解释。
      const notice = reason ?? (this.state.mode === 'claude_code' ? '' : '任务已停止，待批准的操作已取消。')
      if (notice) this.add('system', notice)
    }
  }

  /** Releases the SDK query as well as cancelling the current turn. Closing a
   * temporary conversation needs this; stop alone deliberately keeps a main
   * conversation's SDK session resumable. */
  async dispose(): Promise<void> {
    this.stop()
    this.contextGeneration += 1
    const client = this.claudeCodeModel as (ModelClient & { dispose?: () => Promise<void> | void }) | undefined
    await client?.dispose?.()
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

  private hasRunningTool(): boolean {
    return this.state.timeline.some((entry) => entry.kind === 'tool' && entry.tool?.status === 'running')
  }

  private runningAgentActivity(): AgentActivity | undefined {
    for (let index = this.state.timeline.length - 1; index >= 0; index -= 1) {
      const tool = this.state.timeline[index].tool
      if (tool?.status === 'running') return tool.activity ?? agentActivityForTool(tool.name)
    }
    return undefined
  }

  /**
   * A parked question, plan or permission means the turn is waiting on the
   * user, not executing. Once the last one settles, fall back to what the
   * turn was doing: a running tool, or planning the next move.
   */
  private syncApprovalWait(): void {
    if (this.state.proposal || this.state.question || this.state.plan || this.state.permission) {
      this.state.taskStatus = 'awaiting_approval'
      return
    }
    if (this.state.taskStatus !== 'awaiting_approval' || this.state.mode !== 'claude_code' || !this.isBusy()) return
    this.state.taskStatus = this.hasRunningTool() ? 'executing' : 'planning'
    this.state.avatarState = this.state.taskStatus === 'executing' ? 'acting' : 'thinking'
  }

  private disposeClaudeQuery(): void {
    const client = this.claudeCodeModel as (ModelClient & { dispose?: () => Promise<void> | void }) | undefined
    if (!client?.dispose) return
    try {
      void Promise.resolve(client.dispose()).catch(() => undefined)
    } catch { /* The next SDK request will open a fresh query. */ }
  }

  private handleModelReply(reply: ModelReply, progressEntryId?: string): void {
    // 回合直接收尾、没有第二条思考时，插队消息在最终回复前补上。
    this.flushDeferredSteer()
    // 回合结束还没等到回显的插话，视为已完成，别把下一条插话卡住。
    this.pendingSteer = undefined
    this.state.agentActivity = undefined
    this.closeThinkingEntries()
    // 生成时长随本轮记录落盘：账单的 token/s 按它算（不含工具执行与等待）。
    if (reply.generationMs !== undefined && this.state.taskMetrics) {
      this.state.taskMetrics.generationMs = reply.generationMs
    }
    if (this.localGoalKernel && this.state.goal && !reply.interrupted) {
      const raw = reply.text ?? ''
      const done = /\[\[GOAL_DONE\]\]/u.test(raw)
      if (done) reply.text = raw.replace(/\[\[GOAL_DONE\]\]/gu, '').trimEnd()
      const goal = this.state.goal
      const iterations = (goal.iterations ?? 0) + 1
      if (done) {
        this.state.goal = null
        this.pendingGoalContinuation = false
        this.add('system', `目标已完成（${iterations} 轮）。`)
      } else {
        // 没有轮数上限：只要没写 [[GOAL_DONE]] 就继续下一轮。
        this.state.goal = { ...goal, phase: 'confirmed', iterations }
        this.pendingGoalContinuation = true
      }
      this.emit()
    }
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
    } else if (reply.interrupted) {
      // The panel's kill switch did this. Show a hand-back, not a failure:
      // the SDK's own Esc would otherwise surface as "运行失败".
      this.state.taskStatus = 'cancelled'
      this.state.avatarState = 'idle'
      if (this.steerInterruptPending) {
        // 插队：这不是人工中止，队列里的那条消息马上接上，不写中止提示。
        this.steerInterruptPending = false
        this.finishRunningTools('已打断')
        this.emit()
      } else {
        this.add('system', '已由人工中止；会话和待发送消息都保留。')
      }
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
    const existing = this.state.timeline.find((entry) => entry.tool?.toolUseId === event.toolUseId)
    const turnSettled = ['done', 'failed', 'cancelled'].includes(this.state.taskStatus)
    // Some adapters flush a final result after the assistant reply. It may
    // complete an existing row, but it must not append a new tool after the
    // answer or move a settled conversation back into planning/executing.
    if (turnSettled && (event.phase === 'start' || existing?.tool?.status !== 'running')) return
    if (event.phase === 'start') this.closeThinkingEntries()
    const status = event.phase === 'start' ? 'running' : event.isError ? 'error' : 'done'
    // A result whose start was missed (resumed session, late background task)
    // keeps the name if the row already knows it; otherwise it is honestly a
    // generic tool result, never the old literal "未知工具".
    const toolName = event.toolName === 'unknown_tool' && existing?.tool?.name
      ? existing.tool.name
      : event.toolName
    const activity = existing?.tool?.activity ?? agentActivityForTool(toolName, event.kind)
    const text = `${toolLabel(toolName)}${status === 'running' ? '（执行中）' : status === 'error' ? '（失败）' : '（已完成）'}`
    if (existing) {
      existing.text = text
      existing.tool = { ...existing.tool!, status, input: event.input ?? existing.tool?.input, output: event.output ?? existing.tool?.output,
        activity,
        ...(event.images?.length ? { images: event.images } : {}) }
      this.markTimelineDirty(existing)
    } else {
      const entry: TimelineEntry = {
        id: crypto.randomUUID(), time: new Date().toISOString(), kind: 'tool', text,
        tool: { toolUseId: event.toolUseId, name: toolName, status, input: event.input, output: event.output, activity,
          ...(event.images?.length ? { images: event.images } : {}) }
      }
      this.state.timeline.push(entry)
      this.markTimelineDirty(entry)
    }
    if (!turnSettled) {
      if (event.phase === 'start') {
        this.state.taskStatus = 'executing'
        this.state.avatarState = 'acting'
        this.state.agentActivity = activity
      } else if (!this.hasRunningTool()) {
        this.state.taskStatus = 'planning'
        this.state.avatarState = 'thinking'
        this.state.agentActivity = undefined
      } else {
        this.state.agentActivity = this.runningAgentActivity()
      }
      // A parked question/permission keeps the turn in awaiting_approval even
      // while tool results trickle in.
      this.syncApprovalWait()
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

  /** Quit/restart has no result for a tool that was still running. Drop those
   *  rows instead of leaving a red "interrupted" failure in the transcript. */
  private dropRunningTools(): void {
    const before = this.state.timeline.length
    this.state.timeline = this.state.timeline.filter((entry) =>
      !(entry.kind === 'tool' && entry.tool?.status === 'running'))
    this.state.agentActivity = undefined
    if (this.state.timeline.length === before) return
    this.state.timelineRevision += 1
    this.timelineDirty.clear()
    this.timelineSentRevision = -1
  }

  private finishRunningTools(reason: string): void {
    for (const entry of this.state.timeline) {
      if (entry.kind !== 'tool' || entry.tool?.status !== 'running') continue
      entry.tool.status = 'error'
      entry.tool.output ??= reason
      entry.text = `${toolLabel(entry.tool.name)}（${reason}）`
      this.markTimelineDirty(entry)
    }
    this.state.agentActivity = undefined
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
      this.addSystem(error instanceof Error ? publicErrorText(error.message) : '无法准备笔记草稿。', 'error')
    }
  }

  private finishWithText(text: string): void {
    this.history.push({ role: 'assistant', content: text })
    this.state.taskStatus = 'done'
    this.state.avatarState = 'idle'
    this.state.agentActivity = undefined
    this.add('assistant', text)
  }

  private add(kind: TimelineEntry['kind'], text: string, images?: TimelineEntry['images'],
    sender?: TimelineEntry['sender'], tone?: TimelineEntry['tone']): TimelineEntry {
    const entry: TimelineEntry = {
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      kind,
      text,
      ...(images?.length ? { images } : {}),
      ...(sender ? { sender } : {}),
      ...(tone ? { tone } : {})
    }
    this.state.timeline.push(entry)
    this.markTimelineDirty(entry)
    this.emit()
    return entry
  }

  /** A notice occupies its own row in the panel; `error` switches it to the
   *  warning treatment instead of the quiet centered line. */
  private addSystem(text: string, tone?: TimelineEntry['tone']): TimelineEntry {
    return this.add('system', text, undefined, undefined, tone)
  }

  /** Shows a message from another local conversation/agent without starting a
   *  model turn. It is a visible notice, not part of the dialogue history. */
  appendExternalMessage(from: { name: string; badge: string }, text: string): void {
    if (!text.trim()) return
    this.add('user', text.trim().slice(0, 8_000), undefined, from)
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
    const billedAt = Date.parse(finishedAt)
    const yuan = usageSpendYuan(usage, billedAt)
    if (yuan === null || !Number.isFinite(yuan)) return
    const charge = Number(yuan.toFixed(9))
    // 记账时刻的档位一并存下：账单展示跟着它走（峰时的轮永远按峰时看），
    // 而不是按「打开账单时几点」重新判档。
    const tier = getPeakStatus(billedAt).tier
    if (tier !== 'unknown') this.state.taskMetrics!.priceTier = tier
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
      this.lastTurnUserId = this.currentTurnUserId
      this.currentTurnUserId = undefined
    }
    // The consumer pulls a snapshot when it is ready to publish one; building one here
    // would clone the whole timeline on every streaming delta for nothing.
    this.onChange()
  }
}
