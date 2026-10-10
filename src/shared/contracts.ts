export type AvatarState = 'idle' | 'thinking' | 'listening' | 'speaking' | 'acting' | 'success' | 'error'
export type ModelMode = 'demo' | 'live' | 'claude_code'
export type BubbleLayout = 'empty' | 'composer' | 'composer_attachments' | 'composer_models' | 'full'

/** Thinking depth: DeepSeek's Anthropic-format effort values plus "off".
 *  Their docs map medium→high, xhigh→high, so we offer only real stops. */
export type EffortLevel = 'off' | 'low' | 'high' | 'max'

/** The CLI's /goal state: a condition it re-checks before every stop. */
export interface AgentGoal {
  condition: string
  iterations: number
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
  endedAt?: string
  /** Image attachments the message carried, so the panel can show the pictures
   *  themselves instead of a file list. */
  images?: Array<{ name: string; path: string }>
  tool?: {
    toolUseId: string
    name: string
    status: 'running' | 'done' | 'error'
    input?: string
    output?: string
  }
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

export interface ConversationSettings {
  visibleConversationTabs: number
  autoArchiveAfterDays: 0 | 7 | 14 | 30
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
}

/** One named model endpoint the assistant can talk to. Keys are stored in the
 *  app's own settings file — this is a single-user desktop app. */
export interface ModelProfile {
  id: string
  /** Display name, e.g. 深度求索. */
  name: string
  /** Anthropic-compatible base URL; requests go to `${baseUrl}/v1/messages`. */
  baseUrl: string
  apiKey: string
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

export interface PendingMessage {
  id: string
  text: string
  attachments: UserAttachment[]
  createdAt: string
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
  conversationLibrary?: ConversationLibraryState
  pendingMessages?: PendingMessage[]
  contextUsage?: ContextUsageSnapshot
  contextCompacting?: boolean
  taskMetrics?: TaskMetrics
  effort?: EffortLevel
  /** Planned-first mode: the session researches and proposes, then implements. */
  planMode?: boolean
  /** null or absent means no goal is active. */
  goal?: AgentGoal | null
  /** The inline question waiting for an answer; absent or null means none. */
  question?: AskQuestionRequest | null
  /** The plan waiting for approval; absent or null means none. */
  plan?: PlanApprovalRequest | null
}

export interface VoiceConfig {
  siliconFlowApiKey?: string
  siliconFlowModel?: string
  siliconFlowBaseUrl?: string
}

export interface PetAPI {
  getSnapshot(): Promise<AppSnapshot>
  sendMessage(text: string, attachments?: UserAttachment[], strategy?: 'queue' | 'steer'): Promise<void>
  getPathForFile(file: File): string
  prepareDroppedFile(filePath: string): Promise<UserAttachment>
  preparePastedFile(request: { name: string; data: string }): Promise<UserAttachment>
  readImagePreview(filePath: string): Promise<string | null>
  createConversation(title?: string): Promise<void>
  selectConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  setConversationPinned(id: string, pinned: boolean): Promise<void>
  archiveConversation(id: string): Promise<void>
  restoreConversation(id: string): Promise<void>
  deleteConversation(id: string): Promise<void>
  getContextUsage(): Promise<ContextUsageSnapshot>
  compactConversation(): Promise<void>
  listClaudeWorkflows(): Promise<ClaudeWorkflowOption[]>
  onSlashUiAction(callback: (action: SlashUiAction) => void): () => void
  searchWorkspaceFiles(query: string): Promise<WorkspaceFileOption[]>
  searchConversations(query: string, archived?: boolean): Promise<ConversationSummary[]>
  removeQueuedMessage(id: string): Promise<void>
  /** Delivers a queued message into the running turn right now (native steer);
   *  when steering is unavailable it jumps to the front of the queue instead. */
  steerQueuedMessage(id: string): Promise<void>
  approveAction(id: string): Promise<void>
  rejectAction(id: string): Promise<void>
  /** Submits the inline answer for a parked question; null skips (declines) it. */
  answerQuestion(id: string, answers: AskAnswers | null): Promise<void>
  /** Approves (true) or rejects (false) a parked plan; a rejection keeps the
   *  model in plan mode so it can revise and propose again. */
  answerPlan(id: string, approved: boolean): Promise<void>
  stop(): Promise<void>
  /** Aborts what the running turn is executing (a stuck command) while the
   *  session and any queued messages survive. */
  interruptTurn(): Promise<void>
  showPanel(): Promise<void>
  hidePanel(): Promise<void>
  getPanelOpen(): Promise<boolean>
  onPanelOpen(callback: (open: boolean) => void): () => void
  showContextMenu(): Promise<void>
  setBalanceOpen(open: boolean): Promise<void>
  onBalanceOpen(callback: (open: boolean) => void): () => void
  getBalance(): Promise<BalanceSnapshot>
  openExternal(url: string): Promise<void>
  setBubbleLayout(layout: BubbleLayout, height?: number): Promise<void>
  setBubbleExpanded(expanded: boolean): Promise<void>
  setModelMode(mode: ModelMode): Promise<void>
  setEffort(level: EffortLevel): Promise<void>
  setPlanMode(on: boolean): Promise<void>
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
  setAvatarState(state: AvatarState): Promise<void>
  getVoiceConfig(): Promise<VoiceConfig>
  transcribeAudio(request: { bytes: number[]; mimeType: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ text: string }>
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
