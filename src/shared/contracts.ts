import type { LibraryItem } from './libraries'

export type AvatarState = 'idle' | 'thinking' | 'listening' | 'speaking' | 'acting' | 'success' | 'error'
export type ModelMode = 'demo' | 'live' | 'claude_code'
export type BubbleLayout = 'empty' | 'composer' | 'composer_attachments' | 'composer_models' | 'full'
/** 展开方向：人物在上半屏时窗口向下，在下半屏时窗口向上（跟随人物）。 */
export type PanelDirection = 'up' | 'down'

/** 聊天面板相对人物的位置；默认上方。 */
export type PanelPlacement = 'top' | 'bottom' | 'left' | 'right'

/** 聊天面板配色；状态色不随它变化。 */
export type PanelTheme = 'dark' | 'light'
/** Which agent runtime executes turns. `dsh` is a gray preview; Claude stays
 *  the default until the DSH adapter passes full regression. */
export type AgentKernelKind = 'claude_code' | 'dsh'
export function isAgentKernelKind(value: unknown): value is AgentKernelKind {
  return value === 'claude_code' || value === 'dsh'
}

/** Thinking depth: DeepSeek's Anthropic-format effort values plus "off".
 *  Their docs map medium→high, xhigh→high, so we offer only real stops. */
export type EffortLevel = 'off' | 'low' | 'high' | 'max'

/** Overall UI size: one step up from "small" (the shipped look) is "medium",
 *  then "large". Every window derives its type scale from this. */
export type UiSize = 'small' | 'medium' | 'large'

/** 桌面人物的大小档：小 = 当前 128px 长边，中 = 之前的 139.5px，大 = 152px。 */
export type AvatarSize = 'small' | 'medium' | 'large'

/** 工具行右侧信息的详细程度：full = 参数/改动行数都显示；brief = 只留很短
 *  的参数预览；name = 只显示工具名和状态。 */
export type ToolRowDetail = 'full' | 'brief' | 'name'

/** The desktop portrait implementation. `live2d-preview` is deliberately a
 * fixed technical preview rather than an arbitrary model URL. */
export type AvatarRenderer = 'sprite' | 'live2d-preview'

export function isAvatarRenderer(value: unknown): value is AvatarRenderer {
  return value === 'sprite' || value === 'live2d-preview'
}

/** The portrait's visible rectangle inside the avatar window, in window
 *  coordinates. The renderer measures the trimmed artwork and reports it so
 *  the window hit shape covers the character and nothing else. */
export interface AvatarBox {
  x: number
  y: number
  width: number
  height: number
}

/** The CLI's /goal state: a condition it re-checks before every stop. */
export interface AgentGoal {
  condition: string
  phase: 'requested' | 'confirmed' | 'stopping' | 'unverified'
  /** Only SDK active_goal events can confirm an iteration count. */
  iterations?: number
  startedAt: string
  statusMessage?: string
  /** Why the goal's own stop hook did not consider it met last round. */
  lastReason?: string
}

export type GrowthStatus = 'proposed' | 'running' | 'ready' | 'failed' | 'stale' | 'adopted' | 'published' | 'discarded'

export interface GrowthProposal {
  id: string
  title: string
  objective: string
  evidence: string
  sourceConversationId?: string
  status: GrowthStatus
  createdAt: string
  updatedAt: string
  baseCommit?: string
  experimentCommit?: string
  diff?: string
  checks?: Array<{ name: string; ok: boolean; output: string }>
  releaseNotes?: string
  version?: string
  error?: string
}

export type TaskStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TimelineEntry {
  id: string
  time: string
  kind: 'user' | 'assistant' | 'system' | 'tool' | 'thinking'
  text: string
  /** System notices only: `error` renders as a warning, apart from the
   *  ordinary muted notice line. */
  tone?: 'error'
  endedAt?: string
  /** Settled usage and price of the task this user message started. Kept with
   *  the turn so past footers survive switching conversations or restarting. */
  metrics?: TaskMetrics
  /** A message steered into a turn that was already running: it belongs to
   *  that turn in place — no second avatar, no rail mark — instead of
   *  opening a block of its own. */
  interrupted?: boolean
  /** A restart boundary: render as a line with the text in the middle and
   *  start a new segment instead of showing a user bubble. */
  divider?: boolean
  /** Image attachments the message carried, so the panel can show the pictures
   *  themselves instead of a file list. */
  images?: Array<{ name: string; path: string }>
  /** Present when another local conversation/agent injected this message.
   *  The badge is shown where the user's avatar normally sits. */
  sender?: { name: string; badge: string }
  tool?: {
    toolUseId: string
    name: string
    status: 'running' | 'done' | 'error'
    input?: string
    output?: string
    /** Image files returned by the tool, opened with the system viewer on demand. */
    images?: Array<{ name: string; path: string }>
  }
}

export type SubagentStatus = 'running' | 'completed' | 'failed' | 'stopped'

/**
 * One Task-tool subagent as the SDK reports it. Read-only: the panel draws a
 * robot head per task and expands the row into these fields plus the child's
 * own timeline. `timeline` is capped by the main process; it is a snapshot,
 * not a second full transcript.
 */
export interface SubagentTask {
  taskId: string
  /** The Task tool_use block that started this subagent. */
  toolUseId?: string
  description: string
  subagentType?: string
  status: SubagentStatus
  /** Progress and notification usage, as the SDK counted them. */
  toolUses?: number
  totalTokens?: number
  durationMs?: number
  lastToolName?: string
  /** One-line progress summary, when the SDK supplies one. */
  summary?: string
  /** True once the task runs without blocking the main turn. */
  isBackgrounded?: boolean
  /** Set when this subagent was spawned from inside another one. */
  parentTaskId?: string
  /** Local receive time, used for the live elapsed label and retention. */
  startedAt?: string
  endedAt?: string
  timeline?: TimelineEntry[]
}

export interface ProposedAction {
  id: string
  tool: 'write_test_note'
  description: string
  target: string
  content: string
  risk: 'read' | 'write' | 'execute'
}

export interface UserAttachment {
  name: string
  content: string
  /** Canonical absolute path of a file explicitly dropped by the user. */
  path?: string
}

export interface BalanceLine {
  currency: 'CNY' | 'USD'
  total: string
  granted: string
  toppedUp: string
}

export interface BalanceSnapshot {
  available: boolean
  balances: BalanceLine[]
  checkedAt: string
}

/** 展开面板的最小尺寸：拖拽手柄与窗口布局共用同一套钳制。 */
export const PANEL_MIN_WIDTH = 360
export const PANEL_MIN_HEIGHT = 400

/** 自动压缩上下文的百分比阈值：默认 80，可在 50–90 之间用滚轮调整。 */
export const AUTO_COMPACT_DEFAULT_PERCENT = 80
export const AUTO_COMPACT_MIN_PERCENT = 50
export const AUTO_COMPACT_MAX_PERCENT = 90

export function isAutoCompactPercent(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= AUTO_COMPACT_MIN_PERCENT && value <= AUTO_COMPACT_MAX_PERCENT
}

export interface ConversationSettings {
  visibleConversationTabs: number
  autoArchiveAfterDays: 0 | 7 | 14 | 30
  goalMaxIterations: number
  goalMaxMinutes: number
  memoryEnabled: boolean
  /** How deep the model thinks. Values are exactly what DeepSeek accepts on
   *  both wire formats; the app rewrites every outgoing request to match. */
  effort: EffortLevel
  /** Named Anthropic-compatible endpoints the model menu can switch between. */
  modelProfiles: ModelProfile[]
  /** The profile in use; null falls back to the launch environment. */
  activeModelProfileId: string | null
  /** Whether finished conversations get a model-refined title (the first-line
   *  fallback title is always written). */
  enableAutoTitleGeneration: boolean
  /** Whether message rows show their clock time. */
  showMessageTimestamps: boolean
  /** What the assistant calls the user, and what the user calls it. */
  userName: string
  assistantName: string
  /** File name inside the avatars directory, or null for the glyph default. */
  userAvatar: string | null
  assistantAvatar: string | null
  /** The quick tabs' arrangement, by conversation id. The store keeps every
   *  conversation in the list — dragging rewrites it, deletions prune it, and
   *  ids the user never placed simply follow by recency. */
  tabOrder: string[]
  /** The expanded panel's size, as the user dragged it. Absent means "use the
   *  default full-height panel". The compact bubble keeps its fixed size. */
  panelSize?: { width: number; height: number }
  /** 聊天面板贴在人物的哪一侧；缺省按“上方”。 */
  panelPlacement?: PanelPlacement
  /** 聊天面板的配色；缺省深色。状态色两套共用。 */
  panelTheme?: PanelTheme
  /** The whole interface's type scale. "small" is the original look. */
  uiSize: UiSize
  /** 桌面人物的显示大小；命中区和窗口都跟着它走。 */
  avatarSize: AvatarSize
  /** 工具行显示多少细节。缺省按 brief 处理。 */
  toolRowDetail?: ToolRowDetail
  /** 桌面人物的渲染实现。缺失或无效的旧数据回退到标准插画。 */
  avatarRenderer?: AvatarRenderer
  /** 是否允许模型联网搜索/抓取。关闭时工具直接从工具列表移除，并在
   *  人设里明确告知不可搜索，避免模型反复尝试。 */
  webSearchEnabled?: boolean
  /** 当前人设预设（xiaojing / rin / rem / yui / yukino），同时决定人设文字、
   *  对话头像和桌面主角色。 */
  personaId?: string
  /** Agent 内核；缺失表示 Claude Code。切换只影响之后创建的运行时。 */
  agentKernel?: AgentKernelKind
  /** 上下文用到多少百分比时自动压缩，50–90，默认 80。 */
  autoCompactPercent?: number
  /** Claude Code 的回答风格；空值表示跟随 CLI 默认。 */
  outputStyle?: string
  /** 追加在人设之后的额外指令，留空表示不加。 */
  appendSystemPrompt?: string
  /** 新内容到达时是否自动跟随到底部。默认开启。 */
  autoScroll?: boolean
  /** 文件编辑类工具行是否默认展开。默认关闭。 */
  expandFileEditsByDefault?: boolean
  /** 会话库排序：最近更新或创建时间。默认最近更新。 */
  sessionSort?: 'updated' | 'created'
  /** 自动生成标题时使用的语言；auto 跟随对话语言。 */
  titleLocale?: 'auto' | 'zh' | 'en'
  /** 自动生成标题使用的 DeepSeek 模型。 */
  titleModel?: string
  /** 是否加载 ~/.claude 的用户设置（权限、hooks、输出风格等）。默认开启。 */
  loadUserSettings?: boolean
}

/** One named model endpoint. Main-process storage encrypts credentials;
 *  renderer snapshots contain only configured flags, never secret values. */
export interface ModelProfile {
  id: string
  /** Display name, e.g. 深度求索. */
  name: string
  /** Anthropic-compatible base URL; requests go to `${baseUrl}/v1/messages`. */
  baseUrl: string
  apiKey: string
  /** Public settings snapshots carry these flags and never the stored secret. */
  apiKeyConfigured?: boolean
  extraEnvConfigured?: boolean
  needsKeyReentry?: boolean
  /** Main model id, e.g. deepseek-chat. */
  model: string
  /** Small/fast model for background work; falls back to `model`. */
  smallModel?: string
  /** Extra KEY=VALUE lines merged into the CLI environment (advanced). */
  extraEnv?: string
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  /** Last real message activity; listing order and date groups use this so a
   *  rename or pin does not move the row. Older records fall back to updatedAt. */
  lastActivityAt: string
  archivedAt: string | null
  pinnedAt: string | null
  mode: ModelMode
  taskStatus: TaskStatus
  messageCount: number
  preview: string
}

export interface ConversationLibraryState {
  settings: ConversationSettings
  activeConversationId: string | null
  conversations: ConversationSummary[]
}

export type ConversationBatchAction = 'archive' | 'restore' | 'delete' | 'pin' | 'unpin'
export type ConversationBatchSkipReason =
  | 'not_found' | 'busy' | 'already_archived' | 'not_archived'
  | 'archived' | 'already_pinned' | 'not_pinned'
export interface ConversationBatchResult {
  action: ConversationBatchAction
  /** One outcome per distinct requested ID, in selection order. */
  outcomes: Array<
    { id: string; status: 'updated' } |
    { id: string; status: 'skipped'; reason: ConversationBatchSkipReason }
  >
}

export interface PendingMessage {
  id: string
  text: string
  attachments: UserAttachment[]
  createdAt: string
  /** A restart divider: opens a new segment but renders as a cut line. */
  divider?: boolean
}

export interface ContextUsageSnapshot {
  status: 'available' | 'unavailable'
  compactionOutcome?: 'compacted' | 'not_needed'
  usedTokens?: number
  maxTokens?: number
  usedPercent?: number
  remainingTokens?: number
  remainingPercent?: number
  autoCompactThresholdTokens?: number
  autoCompactThresholdPercent?: number
  checkedAt?: string
}

/**
 * Main-model token throughput, split the way the endpoint billed it: cache hits
 * cost a fraction of fresh input, and output is priced on its own. The split is
 * optional — the direct DeepSeek path only reports a total.
 */
export interface TaskUsage {
  total: number
  input?: number
  output?: number
  cacheRead?: number
  cacheCreate?: number
}

/** Real usage for the current task. Token count covers the main model loop only. */
export interface TaskMetrics {
  startedAt: string
  finishedAt?: string
  usedTokens?: number
  usage?: TaskUsage
  /** Mark recovered historical usage separately from live SDK accounting. */
  usageSource?: 'transcript_estimate'
  /** This turn's charge at the price tier in force when it finished. Absent
   *  when token buckets or the applicable price are unknown. */
  spentYuan?: number
  /** 记账时（这一轮结束那一刻）所落的峰谷档，随记录一起持久化。账单的乘数
   *  展示按它走：峰时跑的轮永远按峰时看，不看「此刻几点」。 */
  priceTier?: 'peak' | 'off_peak'
  /** 连续生成的累计时长（毫秒）——token/s 的分母，不含工具执行与等待。
   *  旧记录没有这个字段，展示时回退到整轮墙钟。 */
  generationMs?: number
}

/** DSH's sandbox presets, plus the app's own self-evolution tier.
 *
 *  `read-only` forbids writes, `workspace-write` allows changes inside the
 *  workspace and asks when DSH requests consent, `danger-full-access` runs
 *  without sandbox prompts, and `selfEvolve` is full access plus app-level
 *  source editing, packaging, restart, and cross-restart continuation. */
export type ApprovalMode = 'read-only' | 'workspace-write' | 'danger-full-access' | 'selfEvolve'

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === 'read-only' || value === 'workspace-write' ||
    value === 'danger-full-access' || value === 'selfEvolve'
}

/** Old records used Claude's names. Map them onto the DSH presets so a
 *  conversation saved before the migration keeps its effective permission. */
export function normalizeApprovalMode(value: unknown): ApprovalMode {
  if (value === 'read-only' || value === 'workspace-write' ||
      value === 'danger-full-access' || value === 'selfEvolve') return value
  if (value === 'plan') return 'read-only'
  if (value === 'default' || value === 'acceptEdits') return 'workspace-write'
  if (value === 'bypassPermissions') return 'danger-full-access'
  return 'workspace-write'
}

/** A compaction in progress: `auto` marks the CLI's own threshold-triggered
 *  one, as opposed to the app's pre-send compact or a manual /compact. */
export interface CompactionState {
  active: boolean
  auto: boolean
}

/** One tool call parked until the user allows or denies it. */
export interface ToolPermissionRequest {
  id: string
  tool: string
  /** One human-readable line: what it wants to do. */
  summary: string
  /** The call's input, pretty-printed and capped, for the expanded view. */
  input: string
}

/** One choice inside an ask-user question; the description shows under the label. */
export interface AskQuestionOption {
  label: string
  description?: string
}

/** One question the assistant parked and the panel is showing. `key` is the
 *  answer map's key: the CLI's question id when present, the question text
 *  otherwise — the same key the CLI matches answers back with. */
export interface AskQuestion {
  key: string
  question: string
  header?: string
  options: AskQuestionOption[]
  multiSelect: boolean
}

/** The AskUserQuestion call waiting for the user; answered in the composer's place. */
export interface AskQuestionRequest {
  id: string
  questions: AskQuestion[]
}

/** The ExitPlanMode call waiting for the user; the plan text comes from the
 *  call's own input, and approving it is what lets the CLI leave plan mode. */
export interface PlanApprovalRequest {
  id: string
  plan: string
}

/** Question key → chosen label (labels array for multiSelect); free text allowed. */
export type AskAnswers = Record<string, string | string[]>

export interface ClaudeWorkflowOption {
  name: string
  description: string
  kind: 'command' | 'skill'
  source: 'user' | 'project' | 'builtin'
}

export type SlashUiAction = 'sessions' | 'model' | 'help'

export interface WorkspaceFileOption {
  relativePath: string
  name: string
  /** Older renderer mocks omit this; new search results distinguish folders. */
  kind?: 'file' | 'directory'
}

/** 当前内核在握手后能确认的能力；缺省字段表示还不知道。 */
export interface AgentCapabilities {
  /** 模型是否声明了图片输入（true 才会把图片内联发给模型）。 */
  imageInput?: boolean
}

export interface AppSnapshot {
  mode: ModelMode
  avatarState: AvatarState
  taskStatus: TaskStatus
  timeline: TimelineEntry[]
  /** Monotonic timeline version. When `timelinePartial` is set, `timeline`
   *  carries only the entries changed since the renderer's last applied
   *  revision (upsert by id); otherwise it is the full history. */
  timelineRevision: number
  /** True when `timeline` is an incremental update, not the whole history. */
  timelinePartial?: boolean
  proposal?: ProposedAction
  currentTask?: string
  modelReady: boolean
  claudeCodeReady: boolean
  /** Which conversation this snapshot describes (the displayed one). The
   *  renderer resets its timeline-revision bookkeeping when it changes. */
  conversationId?: string
  /** 工作区绝对路径；时间线用它把长路径缩成 `~/…`。 */
  workspace?: string
  conversationLibrary?: ConversationLibraryState
  pendingMessages?: PendingMessage[]
  /** 插话已投递给模型、还没轮到显示时，队列区用它提示“正在插话”。 */
  steering?: { text: string; startedAt: string }
  contextUsage?: ContextUsageSnapshot
  contextCompacting?: boolean
  /** True while the CLI compacts on its own at the auto threshold; the status
   *  row then says "正在自动压缩上下文" instead of staying silent. */
  contextCompactingAuto?: boolean
  taskMetrics?: TaskMetrics
  /** What this conversation has cost so far, in yuan, priced by the DeepSeek
   *  peak/off-peak tier each turn settled in. */
  conversationSpentYuan?: number
  effort?: EffortLevel
  /** Planned-first mode: the session researches and proposes, then implements. */
  planMode?: boolean
  /** null or absent means no goal is active. */
  goal?: AgentGoal | null
  /** The inline question waiting for an answer; absent or null means none. */
  question?: AskQuestionRequest | null
  /** The plan waiting for approval; absent or null means none. */
  plan?: PlanApprovalRequest | null
  /** The tool call waiting for the user's allow/deny; absent or null means none. */
  permission?: ToolPermissionRequest | null
  /** The conversation's permission mode; absent matches the old auto-approve. */
  approvalMode?: ApprovalMode
  /** Live Task-tool subagents; absent or empty means none. */
  subagents?: SubagentTask[]
  /** 当前内核是否支持后台运行/停止/转达子代理；缺省视为支持。DSH 只有
   *  子代理工具调用，宿主没有这些控制，托盘据此隐藏按钮。 */
  subagentControls?: boolean
  /** The last approved plan, kept after plan mode ends for the task strip. */
  approvedPlan?: string
  /** Why the queued messages stopped draining (goal budget, stop, persona). */
  queuePauseReason?: string
}

/** An in-memory side conversation attached to the currently displayed chat.
 * The model state is public UI data; its history and credentials stay in main. */
export interface SideChatSnapshot {
  sessionId: string | null
  parentConversationId: string | null
  expanded: boolean
  queuePaused: boolean
  pauseReason?: string
  snapshot: AppSnapshot | null
  pendingMessages: PendingMessage[]
}

export interface VoiceConfig {
  siliconFlowAvailable?: boolean
  siliconFlowModel?: string
  siliconFlowBaseUrl?: string
  ttsAvailable?: boolean
  ttsModel?: string
  voice?: string
  speed?: number
  autoSpeak?: boolean
  needsKeyReentry?: boolean
}

/** Renderer-facing voice settings. It never carries the API key itself. */
export interface VoiceSettingsPublic {
  keyConfigured: boolean
  envKeyAvailable: boolean
  needsKeyReentry: boolean
  protectionUnavailable: boolean
  loadError: boolean
  voice: string
  speed: number
  autoSpeak: boolean
  baseUrl: string
  sttModel: string
  ttsModel: string
  lastDocumentJob?: VoiceJobProgress
}

export interface VoiceSettingsPatch {
  apiKey?: string
  clearKey?: boolean
  importEnvKey?: boolean
  voice?: string
  speed?: number
  autoSpeak?: boolean
  baseUrl?: string
}

export interface VoiceJobProgress {
  jobId: string
  phase: 'preparing' | 'synthesizing' | 'finalizing' | 'done' | 'cancelled' | 'failed'
  completed: number
  total: number
  outputDir?: string
  message?: string
}

export interface PetAPI {
  getSnapshot(): Promise<AppSnapshot>
  getSideChat(): Promise<SideChatSnapshot>
  openSideChat(): Promise<SideChatSnapshot>
  setSideChatExpanded(sessionId: string, expanded: boolean): Promise<SideChatSnapshot>
  discardSideChat(sessionId: string): Promise<void>
  sendSideChatMessage(sessionId: string, text: string, attachments?: UserAttachment[], strategy?: 'queue' | 'steer'): Promise<void>
  stopSideChat(sessionId: string): Promise<void>
  interruptSideChat(sessionId: string): Promise<void>
  removeSideQueuedMessage(sessionId: string, messageId: string): Promise<void>
  steerSideQueuedMessage(sessionId: string, messageId: string): Promise<void>
  approveSideChatAction(sessionId: string, id: string): Promise<void>
  rejectSideChatAction(sessionId: string, id: string): Promise<void>
  answerSideChatQuestion(sessionId: string, id: string, answers: AskAnswers | null): Promise<void>
  answerSideChatPlan(sessionId: string, id: string, approved: boolean): Promise<void>
  getSideChatContextUsage(sessionId: string): Promise<ContextUsageSnapshot>
  compactSideChat(sessionId: string): Promise<void>
  setSideChatModelMode(sessionId: string, mode: ModelMode): Promise<void>
  setSideChatPlanMode(sessionId: string, on: boolean): Promise<void>
  onSideChatSnapshot(callback: (snapshot: SideChatSnapshot) => void): () => void
  /** `conversationId` targets a specific conversation; omitted = the one
   *  currently displayed. Every turn-scoped call below follows that rule. */
  sendMessage(text: string, attachments?: UserAttachment[], strategy?: 'queue' | 'steer', conversationId?: string): Promise<void>
  getPathForFile(file: File): string
  prepareDroppedFile(filePath: string): Promise<UserAttachment>
  preparePastedFile(request: { name: string; data: string }): Promise<UserAttachment>
  readImagePreview(filePath: string): Promise<string | null>
  createConversation(title?: string): Promise<void>
  selectConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  setConversationPinned(id: string, pinned: boolean): Promise<void>
  setConversationTabOrder(ids: string[]): Promise<void>
  archiveConversation(id: string): Promise<void>
  restoreConversation(id: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  /** Destructive actions are confirmed by the caller before this method is invoked. */
  batchManageConversations(action: ConversationBatchAction, ids: string[]): Promise<ConversationBatchResult>
  deleteTurn(conversationId: string, userEntryId: string): Promise<void>
  getContextUsage(conversationId?: string): Promise<ContextUsageSnapshot>
  compactConversation(conversationId?: string): Promise<void>
  listClaudeWorkflows(): Promise<ClaudeWorkflowOption[]>
  onSlashUiAction(callback: (action: SlashUiAction) => void): () => void
  searchWorkspaceFiles(query: string): Promise<WorkspaceFileOption[]>
  searchConversations(query: string, archived?: boolean): Promise<ConversationSummary[]>
  /** Installed MCP, skill, and plugin entries for the composer's @ picker. */
  listLibraries(): Promise<LibraryItem[]>
  removeQueuedMessage(id: string): Promise<void>
  /** Delivers a queued message into the running turn right now (native steer);
   *  when steering is unavailable it jumps to the front of the queue instead. */
  steerQueuedMessage(id: string): Promise<void>
  approveAction(id: string, conversationId?: string): Promise<void>
  rejectAction(id: string, conversationId?: string): Promise<void>
  /** Submits the inline answer for a parked question; null skips (declines) it. */
  answerQuestion(id: string, answers: AskAnswers | null, conversationId?: string): Promise<void>
  /** Approves (true) or rejects (false) a parked plan; a rejection keeps the
   *  model in plan mode so it can revise and propose again. */
  answerPlan(id: string, approved: boolean, conversationId?: string): Promise<void>
  /** Allows (true) or denies (false) the parked tool call. */
  answerPermission(id: string, allow: boolean, conversationId?: string): Promise<void>
  setApprovalMode(mode: ApprovalMode, conversationId?: string): Promise<void>
  /** The composer text as typed, kept per conversation so closing the window
   *  or the app never loses a half-written message. */
  saveDraft(conversationId: string, text: string): Promise<void>
  getDraft(conversationId: string): Promise<string>
  /** Ends a running goal the only way the CLI accepts: its own /goal clear
   *  command, sent as a turn of its own behind an interrupt of the loop's
   *  current turn. Steered text never reaches it as a command. */
  clearGoal(conversationId?: string): Promise<void>
  stop(conversationId?: string): Promise<void>
  /** Aborts what the running turn is executing (a stuck command) while the
   *  session and any queued messages survive. */
  interruptTurn(conversationId?: string): Promise<void>
  /** Moves a blocking foreground subagent into the background so the main turn
   *  continues; false when the SDK matched no foreground task. */
  backgroundTask(toolUseId: string, conversationId?: string): Promise<boolean>
  /** Stops one subagent; the SDK emits task_notification with status stopped. */
  stopTask(taskId: string, conversationId?: string): Promise<void>
  /** Sends a message into one running subagent's own stream. */
  messageSubagent(toolUseId: string, text: string, conversationId?: string): Promise<boolean>
  /** Resumes a queue paused by a stop, a goal budget or a persona switch. */
  resumeQueue(conversationId?: string): Promise<void>
  showPanel(): Promise<void>
  hidePanel(): Promise<void>
  getPanelOpen(): Promise<boolean>
  onPanelOpen(callback: (open: boolean) => void): () => void
  /** 面板相对人物展开的方向；人物越过屏幕中线时会变化。 */
  getPanelDirection(): Promise<PanelDirection>
  onPanelDirection(callback: (direction: PanelDirection) => void): () => void
  /** 面板贴在人物的哪一侧（上/下/左/右）。 */
  getPanelPlacement(): Promise<PanelPlacement>
  onPanelPlacement(callback: (placement: PanelPlacement) => void): () => void
  showContextMenu(): Promise<void>
  setBalanceOpen(open: boolean): Promise<void>
  /** Flips the balance card from the main process, where the real state lives. */
  toggleBalance(): Promise<void>
  onBalanceOpen(callback: (open: boolean) => void): () => void
  getBalance(): Promise<BalanceSnapshot>
  openExternal(url: string): Promise<void>
  /** Opens an app-owned file (such as a tool's image result) in the system viewer. */
  openPath(path: string): Promise<void>
  setBubbleLayout(layout: BubbleLayout, height?: number): Promise<void>
  setBubbleExpanded(expanded: boolean): Promise<void>
  /** Resizes the expanded panel (the window follows on the main process). */
  setPanelSize(width: number, height: number): Promise<void>
  /** 拖拽缩放手柄时，把全局悬浮手柄移到鼠标位置；null 表示收起。 */
  resizeGhost(pos: { x: number; y: number } | null): void
  /** 角色旁的小批准卡：打包/重启等请示用它，绿勾批准、红叉拒绝。 */
  onApprovalRequest(callback: (request: { id: string; title: string; detail?: string }) => void): () => void
  answerApproval(id: string, approved: boolean): void
  /** 退出重启前让立绘做一个告别表情；宿主没提供时界面照常工作。 */
  onFarewell?(callback: () => void): () => void
  /** Reports the trimmed portrait's rectangle so the hit shape follows it. */
  setAvatarBox(box: AvatarBox): Promise<void>
  setModelMode(mode: ModelMode): Promise<void>
  setEffort(level: EffortLevel): Promise<void>
  /** Turns web search/fetch on or off for every new turn. */
  setWebSearchEnabled(on: boolean): Promise<void>
  /** Sets the auto-compaction threshold (50–90 percent). */
  setAutoCompactPercent(percent: number): Promise<void>
  setPlanMode(on: boolean): Promise<void>
  /** Switches the conversation's permission mode (default / acceptEdits /
   *  plan / bypassPermissions). Side chats keep the main conversation's. */
  setApprovalMode(mode: ApprovalMode, conversationId?: string): Promise<void>
  /** Allows (true) or denies (false) the parked tool call. */
  answerPermission(id: string, allow: boolean, conversationId?: string): Promise<void>
  /** Creates or updates one model profile; the first one becomes active. */
  saveModelProfile(profile: ModelProfile): Promise<void>
  deleteModelProfile(id: string): Promise<void>
  /** Activates a profile (null returns to the launch environment). */
  setModelProfile(id: string | null): Promise<void>
  /** Sends one tiny request to the endpoint and reports what came back. */
  testModelProfile(profile: ModelProfile): Promise<{ ok: boolean; message: string }>
  setEnableAutoTitleGeneration(on: boolean): Promise<void>
  setShowMessageTimestamps(on: boolean): Promise<void>
  setUserNames(userName: string, assistantName: string): Promise<void>
  /** Stores an image as the avatar for `user` or `assistant` (bytes = png/jpeg). */
  setAvatar(kind: 'user' | 'assistant', bytes: number[]): Promise<void>
  /** Data URL of the stored avatar, or null when none is set. */
  readAvatar(kind: 'user' | 'assistant'): Promise<string | null>
  /** Brings the settings window to the front (model management lives there). */
  openSettings(): Promise<void>
  /** Opens the first-run configuration wizard (DeepSeek setup). */
  openOnboarding(): Promise<void>
  setAvatarState(state: AvatarState): Promise<void>
  getVoiceConfig(): Promise<VoiceConfig>
  transcribeAudio(request: { bytes: number[]; mimeType: string }): Promise<{ text: string }>
  /** Synthesizes one short segment; cached audio returns without a request. */
  synthesizeSpeech(request: { text: string; voice?: string; speed?: number }): Promise<{
    audioBase64: string
    mimeType: string
    cached: boolean
  }>
  onVoiceConfigChanged(callback: (config: VoiceConfig) => void): () => void
  voiceLog(level: 'info' | 'error', message: string, data?: unknown): Promise<void>
  quit(): Promise<void>
  beginDrag(position: { x: number; y: number }): Promise<void>
  dragMove(position: { x: number; y: number }): Promise<void>
  endDrag(): Promise<void>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}

declare global {
  interface Window {
    pet: PetAPI
  }
}
