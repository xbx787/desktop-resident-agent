import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DialogueLine } from './deepseek'
import { isEffortLevel } from '../shared/effort'
import { containsSensitiveData } from './memory-service'
import { protectProfiles, restoreProfiles, type SecretCodec } from './secret-storage'
import type { AgentGoal, ApprovalMode, AvatarSize, ConversationBatchAction, ConversationBatchResult, ConversationLibraryState, ConversationSummary, ContextUsageSnapshot, EffortLevel, ModelMode, ModelProfile, PanelPlacement, PanelTheme, SubagentTask, TaskStatus, TimelineEntry, UserAttachment, ConversationSettings, UiSize } from '../shared/contracts'
import { AUTO_COMPACT_DEFAULT_PERCENT, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH, isAgentKernelKind, isAutoCompactPercent, isAvatarRenderer } from '../shared/contracts'
import { isPersonaId } from '../shared/personas'
import { DEFAULT_SKILL_MARKET_SOURCES, isSkillMarketSourceId } from '../shared/skill-market'

const DEFAULT_VISIBLE_TABS = 5
const MAX_VISIBLE_TABS = 12
const LEGACY_MAX_ACTIVE_LIMIT = 50
const DEFAULT_TITLE = '新对话'
export const MAX_BATCH_CONVERSATIONS = 100

/** The store and the renderer share one definition of these shapes; the
 *  re-exports keep the historical import paths working. */
export type { ConversationLibraryState, ConversationSettings, ConversationSummary }

export interface PendingMessage {
  id: string
  text: string
  attachments: UserAttachment[]
  createdAt: string
  /** Frozen at submit time; only the main process uses this model context. */
  sessionContext?: string
  /** A restart divider: opens a new segment but renders as a cut line. */
  divider?: boolean
}

export interface ConversationRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  archivedAt: string | null
  pinnedAt: string | null
  mode: ModelMode
  taskStatus: TaskStatus
  timeline: TimelineEntry[]
  history: DialogueLine[]
  pendingMessages: PendingMessage[]
  sdkSessionId: string | null
  /** 创建/最近一次持久化时使用的模型配置 id；用于导出元数据和跨设备辨认。 */
  providerId?: string
  goal?: AgentGoal | null
  /** Plan mode as last known. The CLI re-reports the real state on its next
   *  init, so this only has to survive the restart in between. */
  planMode?: boolean
  /** The conversation's permission mode. Absent means the pre-existing
   *  auto-approve behaviour (bypassPermissions). */
  approvalMode?: ApprovalMode
  /** The composer text as typed, so closing the window never loses a
   *  half-written message. Attachments are not kept — their staged files do
   *  not survive the restart. */
  draft?: string
  /** Running cost of the conversation in yuan (see AppSnapshot.conversationSpentYuan). */
  spentYuan?: number
  /** 上一次真实读到的上下文用量；重开应用后先显示它，等新回合再刷新。 */
  contextUsage?: ContextUsageSnapshot
  /** When the conversation last saw real message activity. Listing order and
   *  date grouping key off this, so renaming or pinning never moves a row.
   *  Absent on older records — readers fall back to updatedAt. */
  lastActivityAt?: string
  compactionSummary?: string
  /** Entries added to this conversation with @, as `kind:id`. */
  activeLibraries?: string[]
  /** 子代理托盘的最后状态；重启后用来恢复，不假装运行中的任务还活着。 */
  subagents?: SubagentTask[]
}

export interface ConversationPatch {
  title?: string
  mode?: ModelMode
  taskStatus?: TaskStatus
  timeline?: TimelineEntry[]
  history?: DialogueLine[]
  pendingMessages?: PendingMessage[]
  sdkSessionId?: string | null
  providerId?: string
  goal?: AgentGoal | null
  planMode?: boolean
  approvalMode?: ApprovalMode
  draft?: string
  compactionSummary?: string | null
  spentYuan?: number
  contextUsage?: ContextUsageSnapshot
  activeLibraries?: string[]
  subagents?: SubagentTask[]
}

export interface ConversationSearchOptions {
  query?: string
  archived?: boolean
}

export type ConversationStoreErrorCode =
  | 'NOT_FOUND'
  | 'ARCHIVED_CONVERSATION'
  | 'ALREADY_ARCHIVED'
  | 'NOT_ARCHIVED'
  | 'INVALID_INPUT'
  | 'CORRUPT_DATA'

export class ConversationStoreError extends Error {
  constructor(public readonly code: ConversationStoreErrorCode, message: string) {
    super(message)
    this.name = 'ConversationStoreError'
  }
}

interface PersistedLibrary {
  version: 2
  settings: ConversationSettings
  activeConversationId: string | null
  conversations: ConversationRecord[]
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isMode(value: unknown): value is ModelMode {
  return value === 'demo' || value === 'live' || value === 'claude_code'
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'idle' || value === 'planning' || value === 'awaiting_approval' ||
    value === 'executing' || value === 'verifying' || value === 'done' ||
    value === 'failed' || value === 'cancelled'
}

function restoredTaskStatus(value: TaskStatus | undefined): TaskStatus {
  if (!value) return 'idle'
  return value === 'planning' || value === 'awaiting_approval' || value === 'executing' || value === 'verifying'
    ? 'cancelled' : value
}

function isTimeline(value: unknown): value is TimelineEntry[] {
  return Array.isArray(value) && value.every((entry) =>
    isObject(entry) &&
    typeof entry.id === 'string' &&
    typeof entry.time === 'string' &&
    typeof entry.text === 'string' &&
    ['user', 'assistant', 'system', 'tool', 'thinking'].includes(String(entry.kind))
  )
}

function isSubagents(value: unknown): value is SubagentTask[] {
  return Array.isArray(value) && value.length <= 50 && value.every((task) =>
    isObject(task) &&
    typeof task.taskId === 'string' &&
    typeof task.description === 'string' &&
    ['running', 'completed', 'failed', 'stopped'].includes(String(task.status))
  )
}

function isHistory(value: unknown): value is DialogueLine[] {
  return Array.isArray(value) && value.every((line) =>
    isObject(line) &&
    (line.role === 'user' || line.role === 'assistant') &&
    typeof line.content === 'string' &&
    (line.sessionContext === undefined || line.role === 'user' &&
      typeof line.sessionContext === 'string' && Buffer.byteLength(line.sessionContext, 'utf8') <= 26 * 1024)
  )
}

function isPendingMessages(value: unknown): value is PendingMessage[] {
  return Array.isArray(value) && value.every((message) =>
    isObject(message) &&
    typeof message.id === 'string' && message.id.length > 0 &&
    typeof message.text === 'string' &&
    typeof message.createdAt === 'string' &&
    (message.sessionContext === undefined || typeof message.sessionContext === 'string' && message.sessionContext.length <= 32_768) &&
    Array.isArray(message.attachments) && message.attachments.every((attachment: unknown) =>
      isObject(attachment) && typeof attachment.name === 'string' && typeof attachment.content === 'string' &&
      (attachment.path === undefined || typeof attachment.path === 'string'))
  )
}

function isGoal(value: unknown): value is AgentGoal | null {
  if (value === null) return true
  return isObject(value) && typeof value.condition === 'string' && value.condition.trim().length > 0 &&
    value.condition.length <= 8_000 &&
    ['requested', 'confirmed', 'stopping', 'unverified'].includes(String(value.phase)) &&
    typeof value.startedAt === 'string' && Number.isFinite(Date.parse(value.startedAt)) &&
    (value.iterations === undefined || Number.isSafeInteger(value.iterations) && Number(value.iterations) >= 0) &&
    (value.statusMessage === undefined || typeof value.statusMessage === 'string' && value.statusMessage.length <= 500)
}

function isContextUsage(value: unknown): value is ContextUsageSnapshot {
  if (!isObject(value) || (value.status !== 'available' && value.status !== 'unavailable')) return false
  const numbers = ['usedTokens', 'maxTokens', 'usedPercent', 'remainingTokens', 'remainingPercent',
    'autoCompactThresholdTokens', 'autoCompactThresholdPercent']
  return numbers.every((key) => value[key] === undefined ||
    typeof value[key] === 'number' && Number.isFinite(value[key])) &&
    (value.stale === undefined || typeof value.stale === 'boolean') &&
    (value.compactionOutcome === undefined || value.compactionOutcome === 'compacted' || value.compactionOutcome === 'not_needed') &&
    (value.checkedAt === undefined || typeof value.checkedAt === 'string')
}

type LegacyConversationRecord = Omit<ConversationRecord, 'pendingMessages' | 'pinnedAt' | 'taskStatus' | 'goal'> & {
  pendingMessages?: PendingMessage[]
  pinnedAt?: string | null
  taskStatus?: TaskStatus
  goal?: AgentGoal | null
}

function isRecord(value: unknown): value is LegacyConversationRecord {
  return isObject(value) &&
    typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.title === 'string' && value.title.trim().length > 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.archivedAt === null || typeof value.archivedAt === 'string') &&
    (value.pinnedAt === undefined || value.pinnedAt === null || typeof value.pinnedAt === 'string') &&
    isMode(value.mode) &&
    (value.taskStatus === undefined || isTaskStatus(value.taskStatus)) &&
    isTimeline(value.timeline) &&
    isHistory(value.history) &&
    (value.pendingMessages === undefined || isPendingMessages(value.pendingMessages)) &&
    (value.sdkSessionId === null || typeof value.sdkSessionId === 'string') &&
    (value.providerId === undefined || typeof value.providerId === 'string') &&
    (value.goal === undefined || isGoal(value.goal)) &&
    (value.contextUsage === undefined || isContextUsage(value.contextUsage)) &&
    (value.subagents === undefined || isSubagents(value.subagents)) &&
    (value.compactionSummary === undefined || typeof value.compactionSummary === 'string')
}

function isAutoArchiveDays(value: unknown): value is ConversationSettings['autoArchiveAfterDays'] {
  return value === 0 || value === 7 || value === 14 || value === 30
}

/** A name is short free text; empty falls back to the given default. */
function isDisplayName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 24
}

function isStoredAvatar(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z]+-\d+\.(png|jpe?g|webp)$/i.test(value)
}

export function isModelProfile(value: unknown): value is ModelProfile {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && value.id.trim() !== '' &&
    typeof value.name === 'string' && value.name.trim() !== '' &&
    typeof value.baseUrl === 'string' && /^https?:\/\//i.test(value.baseUrl) &&
    typeof value.apiKey === 'string' && typeof value.model === 'string' && value.model.trim() !== '' &&
    (value.smallModel === undefined || typeof value.smallModel === 'string') &&
    (value.extraEnv === undefined || typeof value.extraEnv === 'string') &&
    (value.enabled === undefined || typeof value.enabled === 'boolean')
}

/** The settings that arrived after version 2 shipped: read leniently so an
 *  older file simply gets the defaults instead of failing to load. */
/** 面板尺寸的读回校验：坏值当作"没存过"，回退到出厂的全高面板。 */
function readPanelSize(value: unknown): { width: number; height: number } | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { width, height } = value as Record<string, unknown>
  return Number.isInteger(width) && Number.isInteger(height) &&
    (width as number) >= PANEL_MIN_WIDTH && (width as number) <= 4000 &&
    (height as number) >= PANEL_MIN_HEIGHT && (height as number) <= 4000
    ? { width: width as number, height: height as number }
    : undefined
}

function isUiSize(value: unknown): value is UiSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isAvatarSize(value: unknown): value is AvatarSize {
  return value === 'small' || value === 'medium' || value === 'large'
}

function isPanelPlacement(value: unknown): value is PanelPlacement {
  return value === 'top' || value === 'bottom' || value === 'left' || value === 'right'
}

function isPanelTheme(value: unknown): value is PanelTheme {
  return value === 'dark' || value === 'light'
}

function readExtendedSettings(settings: Record<string, unknown>): Pick<ConversationSettings,
  'modelProfiles' | 'activeModelProfileId' | 'enableAutoTitleGeneration' | 'showMessageTimestamps' |
  'userName' | 'assistantName' | 'userAvatar' | 'assistantAvatar' | 'tabOrder' |
  'goalMaxIterations' | 'goalMaxMinutes' | 'memoryEnabled' | 'panelSize' | 'panelPlacement' | 'panelTheme' | 'uiSize' | 'avatarSize' | 'avatarRenderer' | 'webSearchEnabled' | 'personaId' | 'agentKernel' | 'autoCompactPercent' |
  'toolRowDetail' |
  'outputStyle' | 'appendSystemPrompt' | 'autoScroll' | 'expandFileEditsByDefault' | 'sessionSort' | 'titleLocale' |
  'titleModel' | 'loadUserSettings' | 'skillMarketSources'> {
  const profiles = Array.isArray(settings.modelProfiles)
    ? (settings.modelProfiles.filter(isModelProfile) as ModelProfile[]).map((profile) => structuredClone(profile))
    : []
  const activeModelProfileId = typeof settings.activeModelProfileId === 'string' &&
    profiles.some((profile) => profile.id === settings.activeModelProfileId)
    ? settings.activeModelProfileId : null
  return {
    modelProfiles: profiles,
    activeModelProfileId,
    enableAutoTitleGeneration: settings.enableAutoTitleGeneration !== false,
    showMessageTimestamps: settings.showMessageTimestamps !== false,
    userName: isDisplayName(settings.userName) ? settings.userName.trim() : '主人',
    assistantName: isDisplayName(settings.assistantName) ? settings.assistantName.trim() : '小鲸',
    userAvatar: isStoredAvatar(settings.userAvatar) ? settings.userAvatar : null,
    assistantAvatar: isStoredAvatar(settings.assistantAvatar) ? settings.assistantAvatar : null,
    tabOrder: Array.isArray(settings.tabOrder) ? settings.tabOrder.filter((id): id is string => typeof id === 'string') : [],
    goalMaxIterations: Number.isInteger(settings.goalMaxIterations) && Number(settings.goalMaxIterations) >= 1 && Number(settings.goalMaxIterations) <= 300 ? Number(settings.goalMaxIterations) : 30,
    goalMaxMinutes: Number.isInteger(settings.goalMaxMinutes) && Number(settings.goalMaxMinutes) >= 0 && Number(settings.goalMaxMinutes) <= 1440 ? Number(settings.goalMaxMinutes) : 0,
    memoryEnabled: settings.memoryEnabled !== false,
    panelSize: readPanelSize(settings.panelSize),
    panelPlacement: isPanelPlacement(settings.panelPlacement) ? settings.panelPlacement : 'top',
    panelTheme: isPanelTheme(settings.panelTheme) ? settings.panelTheme : 'dark',
    uiSize: isUiSize(settings.uiSize) ? settings.uiSize : 'small',
    avatarSize: isAvatarSize(settings.avatarSize) ? settings.avatarSize : 'small',
    avatarRenderer: isAvatarRenderer(settings.avatarRenderer) ? settings.avatarRenderer : 'sprite',
    toolRowDetail: settings.toolRowDetail === 'full' || settings.toolRowDetail === 'name'
      ? settings.toolRowDetail : 'brief',
    webSearchEnabled: settings.webSearchEnabled !== false,
    skillMarketSources: Array.isArray(settings.skillMarketSources)
      ? settings.skillMarketSources.filter(isSkillMarketSourceId)
      : [...DEFAULT_SKILL_MARKET_SOURCES],
    personaId: isPersonaId(settings.personaId) ? settings.personaId : 'xiaojing',
    agentKernel: isAgentKernelKind(settings.agentKernel) ? settings.agentKernel : 'dsh',
    autoCompactPercent: isAutoCompactPercent(settings.autoCompactPercent)
      ? settings.autoCompactPercent : AUTO_COMPACT_DEFAULT_PERCENT,
    ...(typeof settings.outputStyle === 'string' && settings.outputStyle.trim()
      ? { outputStyle: settings.outputStyle.trim().slice(0, 64) } : {}),
    ...(typeof settings.appendSystemPrompt === 'string' && settings.appendSystemPrompt.trim()
      ? { appendSystemPrompt: settings.appendSystemPrompt.trim().slice(0, 4_000) } : {}),
    autoScroll: settings.autoScroll !== false,
    expandFileEditsByDefault: settings.expandFileEditsByDefault === true,
    sessionSort: settings.sessionSort === 'created' ? 'created' : 'updated',
    titleLocale: settings.titleLocale === 'zh' || settings.titleLocale === 'en' ? settings.titleLocale : 'auto',
    titleModel: typeof settings.titleModel === 'string' && settings.titleModel.trim()
      ? settings.titleModel.trim().slice(0, 64) : 'deepseek-flash',
    loadUserSettings: settings.loadUserSettings !== false
  }
}

/** One conversation per file. `library.json` keeps the settings and a light
 *  index (the list metadata), so a single damaged record costs one
 *  conversation instead of the whole library, and writes only touch the
 *  records whose content actually changed. */
function recordDigest(text: string): string {
  // FNV-1a: cheap, and only ever compared against another digest.
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

function metaOf(record: ConversationRecord): ConversationSummary {
  const meta: ConversationSummary = {
    id: record.id, title: record.title, createdAt: record.createdAt, updatedAt: record.updatedAt,
    lastActivityAt: record.lastActivityAt ?? record.updatedAt, archivedAt: record.archivedAt,
    pinnedAt: record.pinnedAt, mode: record.mode, taskStatus: record.taskStatus,
    messageCount: record.timeline.filter((entry) => entry.kind === 'user' || entry.kind === 'assistant').length,
    preview: record.timeline.length ? summaryPreview(record, []) : ''
  }
  return meta
}

/** The index alone carries list metadata; a record file that is missing or
 *  damaged leaves this bare shell so the row stays visible and openable. */
function shellOf(meta: ConversationSummary): ConversationRecord {
  return {
    id: meta.id, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    lastActivityAt: meta.lastActivityAt, archivedAt: meta.archivedAt, pinnedAt: meta.pinnedAt,
    mode: meta.mode, taskStatus: meta.taskStatus, timeline: [], history: [],
    pendingMessages: [], sdkSessionId: null, goal: null
  }
}

function isMeta(value: unknown): value is ConversationSummary {
  if (!isObject(value)) return false
  return typeof value.id === 'string' && typeof value.title === 'string' &&
    typeof value.createdAt === 'string' && typeof value.updatedAt === 'string' &&
    typeof value.lastActivityAt === 'string' && isMode(value.mode) && isTaskStatus(value.taskStatus)
}

/** A v3 index: settings, one active pointer, and one meta per conversation. */
function parseIndex(raw: string): { settings: ConversationSettings; activeConversationId: string | null; metas: ConversationSummary[] } | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ConversationStoreError('CORRUPT_DATA', '会话库 JSON 无法解析，原文件已保留。')
  }
  if (!isObject(value) || value.version !== 3 || !isObject(value.settings) ||
      !Array.isArray(value.conversations) || !value.conversations.every(isMeta) ||
      !(value.activeConversationId === null || typeof value.activeConversationId === 'string')) {
    return null
  }
  const settings = value.settings
  if (!Number.isInteger(settings.visibleConversationTabs) || !isAutoArchiveDays(settings.autoArchiveAfterDays)) {
    return null
  }
  return {
    settings: {
      visibleConversationTabs: Number(settings.visibleConversationTabs),
      autoArchiveAfterDays: settings.autoArchiveAfterDays,
      effort: isEffortLevel(settings.effort) ? settings.effort : 'max',
      ...readExtendedSettings(settings)
    },
    activeConversationId: value.activeConversationId,
    metas: value.conversations as ConversationSummary[]
  }
}

/** Fills the gaps a legacy record may have (field added after it was written). */
function completeRecord(record: LegacyConversationRecord): ConversationRecord {
  return { ...record, pinnedAt: record.pinnedAt ?? null,
    pendingMessages: record.pendingMessages ?? [], taskStatus: restoredTaskStatus(record.taskStatus), goal: record.goal ?? null }
}

function parseLibrary(raw: string): { library: PersistedLibrary; migrated: boolean } {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new ConversationStoreError('CORRUPT_DATA', '会话库 JSON 无法解析，原文件已保留。')
  }
  if (!isObject(value) || (value.version !== 1 && value.version !== 2) || !isObject(value.settings) ||
      !Array.isArray(value.conversations) || !value.conversations.every(isRecord) ||
      !(value.activeConversationId === null || typeof value.activeConversationId === 'string')) {
    throw new ConversationStoreError('CORRUPT_DATA', '会话库格式无效，原文件已保留。')
  }
  const oldFormat = value.version === 1
  const settings = value.settings
  if (oldFormat
    ? (!Number.isInteger(settings.maxActiveConversations) || Number(settings.maxActiveConversations) < 1 ||
      Number(settings.maxActiveConversations) > LEGACY_MAX_ACTIVE_LIMIT)
    : (!Number.isInteger(settings.visibleConversationTabs) || Number(settings.visibleConversationTabs) < 1 ||
      Number(settings.visibleConversationTabs) > MAX_VISIBLE_TABS || !isAutoArchiveDays(settings.autoArchiveAfterDays))) {
    throw new ConversationStoreError('CORRUPT_DATA', '会话库设置无效，原文件已保留。')
  }
  const ids = new Set(value.conversations.map((record) => record.id))
  if (ids.size !== value.conversations.length ||
      (value.activeConversationId !== null &&
        !value.conversations.some((record) => record.id === value.activeConversationId && record.archivedAt === null))) {
    throw new ConversationStoreError('CORRUPT_DATA', '会话库包含重复 ID 或无效的当前会话，原文件已保留。')
  }
  const records = value.conversations as LegacyConversationRecord[]
  return {
    library: {
      version: 2,
      settings: oldFormat
        ? { visibleConversationTabs: Math.min(MAX_VISIBLE_TABS, Number(settings.maxActiveConversations)), autoArchiveAfterDays: 0, effort: 'max',
            ...readExtendedSettings(settings) }
        : { visibleConversationTabs: Number(settings.visibleConversationTabs), autoArchiveAfterDays: settings.autoArchiveAfterDays as ConversationSettings['autoArchiveAfterDays'],
            effort: isEffortLevel(settings.effort) ? settings.effort : 'max', ...readExtendedSettings(settings) },
      activeConversationId: value.activeConversationId as string | null,
      conversations: records.map(completeRecord)
    },
    migrated: oldFormat || !isEffortLevel(settings.effort) || !Array.isArray(settings.tabOrder) || settings.goalMaxIterations === undefined || settings.goalMaxMinutes === undefined || settings.memoryEnabled === undefined || records.some((record) => record.pendingMessages === undefined || record.goal === undefined ||
      record.pinnedAt === undefined || record.taskStatus !== restoredTaskStatus(record.taskStatus))
  }
}

function cleanTitle(title: string): string {
  const clean = title.trim().replace(/\s+/g, ' ')
  if (!clean || clean.length > 120) {
    throw new ConversationStoreError('INVALID_INPUT', '会话标题长度应为 1–120 个字符。')
  }
  return clean
}

function compareByRecent(a: ConversationRecord, b: ConversationRecord,
  sort: 'updated' | 'created' = 'updated'): number {
  const left = sort === 'created' ? b.createdAt : b.lastActivityAt ?? b.updatedAt
  const right = sort === 'created' ? a.createdAt : a.lastActivityAt ?? a.updatedAt
  return left.localeCompare(right) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

function compareForList(a: ConversationRecord, b: ConversationRecord,
  sort: 'updated' | 'created' = 'updated'): number {
  const scopeOrder = Number(a.archivedAt !== null) - Number(b.archivedAt !== null)
  if (scopeOrder !== 0) return scopeOrder
  if (a.archivedAt !== null) return compareByRecent(a, b, sort)
  return Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) || compareByRecent(a, b, sort)
}

const SUMMARY_PREVIEW_LENGTH = 160

/** Search can reach old messages, but a result only needs a short, visible
 *  excerpt. Never put tool/thinking text or the private sessionContext in it. */
function searchTerms(query: string): string[] {
  return query.split(/\s+/u).map((term) => term.toLocaleLowerCase()).filter(Boolean)
}

/** Every term must appear somewhere in the text: "范围 格式" finds a message
 *  that has both words anywhere, instead of demanding them adjacent. */
function matchesTerms(text: string, terms: readonly string[]): boolean {
  if (!terms.length) return true
  const lower = text.toLocaleLowerCase()
  return terms.every((term) => lower.includes(term))
}

function matchingExcerpt(text: string, query: string): string {
  if (containsSensitiveData(text)) return '匹配了含敏感信息的消息'
  const clean = text.replace(/\s+/gu, ' ').trim()
  const needle = query.replace(/\s+/gu, ' ').trim().toLocaleLowerCase()
  const match = clean.toLocaleLowerCase().indexOf(needle)
  const start = match < 0 ? 0 : Math.max(0, match - 40)
  const body = clean.slice(start, start + SUMMARY_PREVIEW_LENGTH - 2)
  return `${start > 0 ? '…' : ''}${body}${start + body.length < clean.length ? '…' : ''}`
}

function summaryPreview(record: ConversationRecord, terms: readonly string[]): string {
  const latestVisible = [...record.timeline].reverse()
    .find((entry) => entry.kind === 'user' || entry.kind === 'assistant')
  const latestPreview = latestVisible?.text.slice(0, SUMMARY_PREVIEW_LENGTH) ?? ''
  if (!terms.length || matchesTerms(record.title, terms)) return latestPreview

  // The timeline is the visible source of truth. History is a fallback for
  // older imported messages that have no corresponding timeline entry.
  for (let index = record.timeline.length - 1; index >= 0; index -= 1) {
    const entry = record.timeline[index]
    if ((entry.kind === 'user' || entry.kind === 'assistant') &&
        matchesTerms(entry.text, terms)) return matchingExcerpt(entry.text, terms[0])
  }
  for (let index = record.history.length - 1; index >= 0; index -= 1) {
    const line = record.history[index]
    if (matchesTerms(line.content, terms)) return matchingExcerpt(line.content, terms[0])
  }
  // The search also indexes tool, thinking and system events; say where the
  // hit is without copying those private or potentially secret-bearing payloads.
  return '匹配了过程记录（思考或工具）'
}

function summaries(records: ConversationRecord[], options: ConversationSearchOptions = {},
  sort: 'updated' | 'created' = 'updated'): ConversationSummary[] {
  const terms = searchTerms(options.query ?? '')
  return records
    .filter((record) => options.archived === undefined || (record.archivedAt !== null) === options.archived)
    .filter((record) => !terms.length || matchesTerms(record.title, terms) ||
      record.timeline.some((entry) => matchesTerms(entry.text, terms)) ||
      record.history.some((line) => matchesTerms(line.content, terms)))
    .sort((a, b) => compareForList(a, b, sort))
    .map((record) => ({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastActivityAt: record.lastActivityAt ?? record.updatedAt,
      archivedAt: record.archivedAt,
      pinnedAt: record.pinnedAt,
      mode: record.mode,
      taskStatus: record.taskStatus,
      messageCount: record.timeline.filter((entry) => entry.kind === 'user' || entry.kind === 'assistant').length,
      preview: summaryPreview(record, terms)
    }))
}

function stateOf(library: PersistedLibrary): ConversationLibraryState {
  return {
    settings: structuredClone(library.settings),
    activeConversationId: library.activeConversationId,
    conversations: summaries(library.conversations, {}, library.settings.sessionSort ?? 'updated')
  }
}

function findRecord(library: PersistedLibrary, id: string): ConversationRecord {
  const record = library.conversations.find((candidate) => candidate.id === id)
  if (!record) throw new ConversationStoreError('NOT_FOUND', '找不到这个会话。')
  return record
}

function selectFallback(library: PersistedLibrary): void {
  library.activeConversationId = library.conversations
    .filter((record) => record.archivedAt === null)
    .sort(compareForList)[0]?.id ?? null
}

function addConversation(library: PersistedLibrary, title: string, mode: ModelMode): ConversationRecord {
  const now = new Date().toISOString()
  const record: ConversationRecord = {
    id: randomUUID(), title, createdAt: now, updatedAt: now, lastActivityAt: now,
    archivedAt: null, pinnedAt: null, mode, taskStatus: 'idle', timeline: [], history: [], pendingMessages: [], sdkSessionId: null, goal: null
  }
  library.conversations.push(record)
  library.settings.tabOrder.unshift(record.id)
  library.activeConversationId = record.id
  return record
}

function normalizeBatchIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.length > MAX_BATCH_CONVERSATIONS ||
      ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)) {
    throw new ConversationStoreError('INVALID_INPUT', `一次最多处理 ${MAX_BATCH_CONVERSATIONS} 个有效会话。`)
  }
  return [...new Set(ids)]
}

export class ConversationStore {
  readonly filePath: string
  private library: PersistedLibrary | null = null
  private initialization: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  /** Content digest of each record as last written, keyed by id. */
  private recordDigests = new Map<string, string>()

  constructor(dataRoot: string, private readonly secretCodec?: SecretCodec) {
    this.filePath = path.join(path.resolve(dataRoot), 'conversations', 'library.json')
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

  private get recordDir(): string {
    return path.join(path.dirname(this.filePath), 'records')
  }

  private recordPath(id: string): string {
    return path.join(this.recordDir, `${id}.json`)
  }

  /** Temp file in the target's own directory, fsync, rename over. */
  private async writeAtomic(target: string, text: string): Promise<void> {
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`)
    try {
      const file = await fs.open(temporary, 'wx')
      try {
        await file.writeFile(text, 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await fs.rename(temporary, target)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async load(): Promise<void> {
    const dir = path.dirname(this.filePath)
    await fs.mkdir(dir, { recursive: true })
    let settings: ConversationSettings | undefined
    let activeConversationId: string | null = null
    let conversations: ConversationRecord[] = []
    let migrating = false
    let raw: string | undefined
    try {
      raw = await fs.readFile(this.filePath, 'utf8')
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error
    }

    if (raw !== undefined) {
      const index = parseIndex(raw)
      if (index) {
        settings = index.settings
        activeConversationId = index.activeConversationId
        const loaded = new Map<string, ConversationRecord>()
        for (const meta of index.metas) {
          // A missing or damaged record leaves its list row visible as a shell
          // instead of taking the rest of the library down with it.
          try {
            const parsed: unknown = JSON.parse(await fs.readFile(this.recordPath(meta.id), 'utf8'))
            loaded.set(meta.id, isRecord(parsed) ? completeRecord(parsed) : shellOf(meta))
          } catch {
            loaded.set(meta.id, shellOf(meta))
          }
        }
        conversations = index.metas.map((meta) => loaded.get(meta.id) ?? shellOf(meta))
      } else {
        // A v1/v2 single-file library: split it below, keeping a copy of the
        // original beside it.
        const parsed = parseLibrary(raw)
        settings = parsed.library.settings
        activeConversationId = parsed.library.activeConversationId
        conversations = parsed.library.conversations
        migrating = true
      }
    }

    if (!settings) {
      settings = { visibleConversationTabs: DEFAULT_VISIBLE_TABS, autoArchiveAfterDays: 0, effort: 'max',
        modelProfiles: [], activeModelProfileId: null, enableAutoTitleGeneration: true, showMessageTimestamps: true,
        userName: '主人', assistantName: '小鲸', userAvatar: null, assistantAvatar: null, tabOrder: [],
        goalMaxIterations: 30, goalMaxMinutes: 0, memoryEnabled: true, uiSize: 'small', avatarSize: 'small', avatarRenderer: 'sprite', agentKernel: 'dsh',
        panelPlacement: 'top', panelTheme: 'dark',
        toolRowDetail: 'brief',
        autoCompactPercent: AUTO_COMPACT_DEFAULT_PERCENT, autoScroll: true, expandFileEditsByDefault: false,
        sessionSort: 'updated', titleLocale: 'auto', titleModel: 'deepseek-flash', loadUserSettings: true }
      migrating = true
    }

    const restored = this.secretCodec
      ? restoreProfiles(settings.modelProfiles, this.secretCodec)
      : { profiles: settings.modelProfiles, changed: false }
    settings.modelProfiles = restored.profiles
    const library: PersistedLibrary = { version: 2, settings, activeConversationId, conversations }

    if (migrating || restored.changed) {
      if (migrating && raw !== undefined) {
        await fs.copyFile(this.filePath, path.join(dir, 'library.v2.bak.json')).catch(() => undefined)
      }
      await this.persist(library)
    }
    this.library = library
  }

  private async persist(library: PersistedLibrary): Promise<void> {
    await fs.mkdir(this.recordDir, { recursive: true })
    const diskSettings = structuredClone(library.settings)
    if (this.secretCodec) diskSettings.modelProfiles = protectProfiles(diskSettings.modelProfiles, this.secretCodec)
    await this.writeAtomic(this.filePath, JSON.stringify({
      version: 3,
      settings: diskSettings,
      activeConversationId: library.activeConversationId,
      conversations: library.conversations.map(metaOf)
    }, null, 2) + '\n')

    // Only the records whose content actually changed get rewritten.
    const next = new Map<string, string>()
    for (const record of library.conversations) {
      const json = JSON.stringify(record, null, 2) + '\n'
      const digest = recordDigest(json)
      next.set(record.id, digest)
      if (this.recordDigests.get(record.id) === digest) continue
      await this.writeAtomic(this.recordPath(record.id), json)
    }
    for (const id of this.recordDigests.keys()) {
      if (!next.has(id)) await fs.rm(this.recordPath(id), { force: true }).catch(() => undefined)
    }
    this.recordDigests = next
  }

  private async mutate<T>(change: (draft: PersistedLibrary) => T): Promise<T> {
    await this.initialize()
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.library!)
      const result = change(draft)
      await this.persist(draft)
      this.library = draft
      return structuredClone(result)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async getState(): Promise<ConversationLibraryState> {
    await this.initialize()
    await this.queue
    return stateOf(this.library!)
  }

  async listConversations(options: ConversationSearchOptions = {}): Promise<ConversationSummary[]> {
    await this.initialize()
    await this.queue
    return summaries(this.library!.conversations, options, this.library!.settings.sessionSort ?? 'updated')
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    await this.initialize()
    await this.queue
    const record = this.library!.conversations.find((candidate) => candidate.id === id)
    return record ? structuredClone(record) : null
  }

  async createConversation(title = DEFAULT_TITLE, mode: ModelMode = 'demo'): Promise<ConversationRecord> {
    const clean = cleanTitle(title)
    if (!isMode(mode)) throw new ConversationStoreError('INVALID_INPUT', '不支持这个模型模式。')
    return this.mutate((draft) => addConversation(draft, clean, mode))
  }

  /** 从另一个设备/备份导入一条完整会话：保留消息与用量，但清掉云端会话
   *  绑定、目标循环和危险审批档，避免导入后自动续跑旧目标。 */
  async importConversation(source: ConversationRecord): Promise<ConversationRecord> {
    if (!isRecord(source)) throw new ConversationStoreError('INVALID_INPUT', '导入的会话格式无效。')
    return this.mutate((draft) => {
      const now = new Date().toISOString()
      const record: ConversationRecord = {
        ...structuredClone(source),
        id: randomUUID(),
        title: cleanTitle(source.title),
        archivedAt: null,
        pinnedAt: null,
        taskStatus: 'idle',
        pendingMessages: [],
        sdkSessionId: null,
        goal: null,
        planMode: false,
        approvalMode: 'workspace-write',
        draft: undefined,
        updatedAt: now,
        lastActivityAt: now
      }
      draft.conversations.push(record)
      draft.settings.tabOrder.unshift(record.id)
      draft.activeConversationId = record.id
      return record
    })
  }

  /** Copy only a settled, final reply. The expected entry ID is checked in
   *  the same write transaction as the new record, so a stale UI cannot fork
   *  a different turn. Model history stays in the main process. */

  setActiveConversation(id: string): Promise<ConversationRecord> {
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (record.archivedAt !== null) {
        throw new ConversationStoreError('ARCHIVED_CONVERSATION', '请先恢复归档会话。')
      }
      draft.activeConversationId = id
      return record
    })
  }

  async updateConversation(id: string, patch: ConversationPatch): Promise<ConversationRecord> {
    const changes = structuredClone(patch)
    if (changes.title !== undefined) changes.title = cleanTitle(changes.title)
    if (changes.mode !== undefined && !isMode(changes.mode)) {
      throw new ConversationStoreError('INVALID_INPUT', '不支持这个模型模式。')
    }
    if (changes.taskStatus !== undefined && !isTaskStatus(changes.taskStatus)) {
      throw new ConversationStoreError('INVALID_INPUT', '任务状态无效。')
    }
    if (changes.timeline !== undefined && !isTimeline(changes.timeline)) {
      throw new ConversationStoreError('INVALID_INPUT', '消息记录格式无效。')
    }
    if (changes.history !== undefined && !isHistory(changes.history)) {
      throw new ConversationStoreError('INVALID_INPUT', '模型上下文格式无效。')
    }
    if (changes.pendingMessages !== undefined && !isPendingMessages(changes.pendingMessages)) {
      throw new ConversationStoreError('INVALID_INPUT', '待发送消息格式无效。')
    }
    if (changes.sdkSessionId !== undefined && changes.sdkSessionId !== null && typeof changes.sdkSessionId !== 'string') {
      throw new ConversationStoreError('INVALID_INPUT', 'SDK 会话 ID 格式无效。')
    }
    if (changes.providerId !== undefined && (typeof changes.providerId !== 'string' || !changes.providerId.trim())) {
      throw new ConversationStoreError('INVALID_INPUT', '模型配置 ID 格式无效。')
    }
    if (changes.goal !== undefined && !isGoal(changes.goal)) {
      throw new ConversationStoreError('INVALID_INPUT', '目标状态格式无效。')
    }
    if (changes.compactionSummary !== undefined && changes.compactionSummary !== null && typeof changes.compactionSummary !== 'string') {
      throw new ConversationStoreError('INVALID_INPUT', '上下文摘要格式无效。')
    }
    if (changes.contextUsage !== undefined && !isContextUsage(changes.contextUsage)) {
      throw new ConversationStoreError('INVALID_INPUT', '上下文用量格式无效。')
    }
    if (changes.activeLibraries !== undefined &&
        (!Array.isArray(changes.activeLibraries) || changes.activeLibraries.length > 64 ||
          changes.activeLibraries.some((id) => typeof id !== 'string' || !/^(mcp|skill|plugin):[^\s]+$/u.test(id)))) {
      throw new ConversationStoreError('INVALID_INPUT', '会话库引用格式无效。')
    }
    if (changes.subagents !== undefined && !isSubagents(changes.subagents)) {
      throw new ConversationStoreError('INVALID_INPUT', '子代理记录格式无效。')
    }
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (changes.title !== undefined) record.title = changes.title
      if (changes.mode !== undefined) record.mode = changes.mode
      if (changes.taskStatus !== undefined) record.taskStatus = changes.taskStatus
      if (changes.timeline !== undefined) record.timeline = changes.timeline
      if (changes.history !== undefined) record.history = changes.history
      // Only content counts as activity; a rename or a pin must not reorder the list.
      if (changes.timeline !== undefined || changes.history !== undefined) record.lastActivityAt = new Date().toISOString()
      if (changes.pendingMessages !== undefined) record.pendingMessages = changes.pendingMessages
      if (changes.sdkSessionId !== undefined) record.sdkSessionId = changes.sdkSessionId
      if (changes.providerId !== undefined) record.providerId = changes.providerId
      if (changes.goal !== undefined) record.goal = changes.goal
      if (changes.planMode !== undefined) record.planMode = changes.planMode
      if (changes.approvalMode !== undefined) record.approvalMode = changes.approvalMode
      if (changes.draft !== undefined) record.draft = changes.draft
      if (changes.compactionSummary === null) delete record.compactionSummary
      else if (changes.compactionSummary !== undefined) record.compactionSummary = changes.compactionSummary
      if (changes.spentYuan !== undefined) record.spentYuan = changes.spentYuan
      if (changes.contextUsage !== undefined) record.contextUsage = changes.contextUsage
      if (changes.activeLibraries !== undefined) record.activeLibraries = changes.activeLibraries
      if (changes.subagents !== undefined) record.subagents = changes.subagents
      record.updatedAt = new Date().toISOString()
      return record
    })
  }

  archiveConversation(id: string): Promise<ConversationLibraryState> {
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (record.archivedAt !== null) throw new ConversationStoreError('ALREADY_ARCHIVED', '会话已经归档。')
      record.archivedAt = new Date().toISOString()
      record.updatedAt = record.archivedAt
      if (draft.activeConversationId === id) selectFallback(draft)
      return stateOf(draft)
    })
  }

  restoreConversation(id: string): Promise<ConversationLibraryState> {
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (record.archivedAt === null) throw new ConversationStoreError('NOT_ARCHIVED', '会话没有归档。')
      record.archivedAt = null
      record.updatedAt = new Date().toISOString()
      draft.activeConversationId = id
      return stateOf(draft)
    })
  }

  deleteConversation(id: string): Promise<ConversationLibraryState> {
    return this.mutate((draft) => {
      findRecord(draft, id)
      draft.conversations = draft.conversations.filter((record) => record.id !== id)
      draft.settings.tabOrder = draft.settings.tabOrder.filter((candidate) => candidate !== id)
      if (draft.activeConversationId === id) selectFallback(draft)
      return stateOf(draft)
    })
  }

  /** One persisted transaction for the whole selection. Runtime guards come
   *  from the controller; the stored queue/status is checked again here so a
   *  cold conversation cannot lose parked work. */
  async batchManageConversations(
    action: ConversationBatchAction,
    ids: string[],
    blockedIds: ReadonlySet<string> = new Set()
  ): Promise<ConversationBatchResult> {
    if (action !== 'archive' && action !== 'restore' && action !== 'delete' &&
        action !== 'pin' && action !== 'unpin') {
      throw new ConversationStoreError('INVALID_INPUT', '批量操作无效。')
    }
    const unique = normalizeBatchIds(ids)
    if (!unique.length) return { action, outcomes: [] }
    return this.mutate((draft) => {
      const now = new Date().toISOString()
      const oldActive = draft.conversations.find((record) => record.id === draft.activeConversationId)
      const oldMode = oldActive?.mode ?? 'claude_code'
      const outcomes: ConversationBatchResult['outcomes'] = []
      const removed = new Set<string>()
      for (const id of unique) {
        const record = draft.conversations.find((candidate) => candidate.id === id)
        if (!record) {
          outcomes.push({ id, status: 'skipped', reason: 'not_found' })
        } else if ((action === 'pin' || action === 'unpin') && record.archivedAt !== null) {
          outcomes.push({ id, status: 'skipped', reason: 'archived' })
        } else if (action === 'pin' && record.pinnedAt !== null) {
          outcomes.push({ id, status: 'skipped', reason: 'already_pinned' })
        } else if (action === 'unpin' && record.pinnedAt === null) {
          outcomes.push({ id, status: 'skipped', reason: 'not_pinned' })
        } else if (action !== 'pin' && action !== 'unpin' &&
            (blockedIds.has(id) || record.pendingMessages.length > 0 ||
            ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(record.taskStatus))) {
          outcomes.push({ id, status: 'skipped', reason: 'busy' })
        } else if (action === 'archive' && record.archivedAt !== null) {
          outcomes.push({ id, status: 'skipped', reason: 'already_archived' })
        } else if (action === 'restore' && record.archivedAt === null) {
          outcomes.push({ id, status: 'skipped', reason: 'not_archived' })
        } else {
          if (action === 'archive') {
            record.archivedAt = now
            record.updatedAt = now
          } else if (action === 'restore') {
            record.archivedAt = null
            record.updatedAt = now
          } else if (action === 'delete') {
            removed.add(id)
          } else {
            record.pinnedAt = action === 'pin' ? now : null
          }
          outcomes.push({ id, status: 'updated' })
        }
      }
      if (removed.size) {
        draft.conversations = draft.conversations.filter((record) => !removed.has(record.id))
        draft.settings.tabOrder = draft.settings.tabOrder.filter((id) => !removed.has(id))
      }
      if (draft.activeConversationId && !draft.conversations.some((record) =>
        record.id === draft.activeConversationId && record.archivedAt === null)) selectFallback(draft)
      if (!draft.activeConversationId && outcomes.some((outcome) => outcome.status === 'updated')) {
        const firstRestored = action === 'restore' ? outcomes.find((outcome) => outcome.status === 'updated')?.id : null
        if (firstRestored) draft.activeConversationId = firstRestored
        else if (action === 'archive' || action === 'delete') addConversation(draft, DEFAULT_TITLE, oldMode)
      }
      return { action, outcomes }
    })
  }

  async updateSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
    const tabs = patch.visibleConversationTabs
    const autoArchive = patch.autoArchiveAfterDays
    const effort = patch.effort
    const modelProfiles = patch.modelProfiles
    const activeModelProfileId = patch.activeModelProfileId
    const { goalMaxIterations, goalMaxMinutes, memoryEnabled } = patch
    const { enableAutoTitleGeneration, showMessageTimestamps, userName, assistantName, userAvatar, assistantAvatar, panelSize, panelPlacement, panelTheme, uiSize, avatarSize, avatarRenderer, toolRowDetail, personaId, agentKernel, autoCompactPercent,
      outputStyle, appendSystemPrompt, autoScroll, expandFileEditsByDefault, sessionSort, titleLocale,
      titleModel, loadUserSettings } = patch
    if (tabs !== undefined && (!Number.isInteger(tabs) || tabs < 1 || tabs > MAX_VISIBLE_TABS)) {
      throw new ConversationStoreError('INVALID_INPUT', `快捷切换显示数量应为 1–${MAX_VISIBLE_TABS}。`)
    }
    if (autoArchive !== undefined && !isAutoArchiveDays(autoArchive)) {
      throw new ConversationStoreError('INVALID_INPUT', '自动归档天数只能是关闭、7、14 或 30。')
    }
    if (effort !== undefined && !isEffortLevel(effort)) {
      throw new ConversationStoreError('INVALID_INPUT', '思考强度只能是关闭、低、高或最大。')
    }
    if (modelProfiles !== undefined && !(Array.isArray(modelProfiles) && modelProfiles.every(isModelProfile))) {
      throw new ConversationStoreError('INVALID_INPUT', '模型配置格式无效。')
    }
    if (goalMaxIterations !== undefined && (!Number.isInteger(goalMaxIterations) || goalMaxIterations < 1 || goalMaxIterations > 300)) {
      throw new ConversationStoreError('INVALID_INPUT', '目标轮数上限应为 1–300。')
    }
    if (goalMaxMinutes !== undefined && (!Number.isInteger(goalMaxMinutes) || goalMaxMinutes < 0 || goalMaxMinutes > 1440)) {
      throw new ConversationStoreError('INVALID_INPUT', '目标时间上限应为 1–1440 分钟。')
    }
    if (memoryEnabled !== undefined && typeof memoryEnabled !== 'boolean') {
      throw new ConversationStoreError('INVALID_INPUT', '记忆开关无效。')
    }
    if (activeModelProfileId !== undefined && activeModelProfileId !== null &&
        (typeof activeModelProfileId !== 'string' || activeModelProfileId.trim() === '')) {
      throw new ConversationStoreError('INVALID_INPUT', '模型配置编号无效。')
    }
    for (const [value, label] of [[enableAutoTitleGeneration, '标题设置'], [showMessageTimestamps, '时间戳设置']] as const) {
      if (value !== undefined && typeof value !== 'boolean') throw new ConversationStoreError('INVALID_INPUT', `${label}无效。`)
    }
    for (const [value, label] of [[userName, '你的称呼'], [assistantName, '我的称呼']] as const) {
      if (value !== undefined && !isDisplayName(value)) throw new ConversationStoreError('INVALID_INPUT', `${label}需为 1–24 个字。`)
    }
    for (const [value, label] of [[userAvatar, '头像'], [assistantAvatar, '头像']] as const) {
      if (value !== undefined && value !== null && !isStoredAvatar(value)) throw new ConversationStoreError('INVALID_INPUT', `${label}文件无效。`)
    }
    if (panelSize !== undefined && (!Number.isInteger(panelSize?.width) || !Number.isInteger(panelSize?.height) ||
        panelSize.width < PANEL_MIN_WIDTH || panelSize.width > 4000 ||
        panelSize.height < PANEL_MIN_HEIGHT || panelSize.height > 4000)) {
      throw new ConversationStoreError('INVALID_INPUT', '面板尺寸无效。')
    }
    if (uiSize !== undefined && !isUiSize(uiSize)) {
      throw new ConversationStoreError('INVALID_INPUT', '界面尺寸只能是小、中或大。')
    }
    if (avatarSize !== undefined && !isAvatarSize(avatarSize)) {
      throw new ConversationStoreError('INVALID_INPUT', '人物大小只能是小、中或大。')
    }
    if (avatarRenderer !== undefined && !isAvatarRenderer(avatarRenderer)) {
      throw new ConversationStoreError('INVALID_INPUT', '人物渲染方式无效。')
    }
    if (toolRowDetail !== undefined && toolRowDetail !== 'full' && toolRowDetail !== 'brief' && toolRowDetail !== 'name') {
      throw new ConversationStoreError('INVALID_INPUT', '工具行详细程度无效。')
    }
    if (personaId !== undefined && !isPersonaId(personaId)) {
      throw new ConversationStoreError('INVALID_INPUT', '人设预设无效。')
    }
    if (agentKernel !== undefined && !isAgentKernelKind(agentKernel)) {
      throw new ConversationStoreError('INVALID_INPUT', 'Agent 内核无效。')
    }
    if (autoCompactPercent !== undefined && !isAutoCompactPercent(autoCompactPercent)) {
      throw new ConversationStoreError('INVALID_INPUT', '自动压缩阈值应为 50–90 之间的整数。')
    }
    if (outputStyle !== undefined && (typeof outputStyle !== 'string' || outputStyle.length > 64)) {
      throw new ConversationStoreError('INVALID_INPUT', '回答风格无效。')
    }
    if (appendSystemPrompt !== undefined && (typeof appendSystemPrompt !== 'string' || appendSystemPrompt.length > 4_000)) {
      throw new ConversationStoreError('INVALID_INPUT', '附加指令不能超过 4000 字。')
    }
    for (const [value, label] of [[autoScroll, '自动跟随'], [expandFileEditsByDefault, '默认展开编辑']] as const) {
      if (value !== undefined && typeof value !== 'boolean') throw new ConversationStoreError('INVALID_INPUT', `${label}设置无效。`)
    }
    if (sessionSort !== undefined && sessionSort !== 'updated' && sessionSort !== 'created') {
      throw new ConversationStoreError('INVALID_INPUT', '会话排序设置无效。')
    }
    if (titleLocale !== undefined && titleLocale !== 'auto' && titleLocale !== 'zh' && titleLocale !== 'en') {
      throw new ConversationStoreError('INVALID_INPUT', '标题语言设置无效。')
    }
    if (titleModel !== undefined && (typeof titleModel !== 'string' || titleModel.length > 64)) {
      throw new ConversationStoreError('INVALID_INPUT', '标题模型设置无效。')
    }
    if (loadUserSettings !== undefined && typeof loadUserSettings !== 'boolean') {
      throw new ConversationStoreError('INVALID_INPUT', '用户设置加载开关无效。')
    }
    return this.mutate((draft) => {
      if (tabs !== undefined) draft.settings.visibleConversationTabs = tabs
      if (autoArchive !== undefined) draft.settings.autoArchiveAfterDays = autoArchive
      if (effort !== undefined) draft.settings.effort = effort
      if (goalMaxIterations !== undefined) draft.settings.goalMaxIterations = goalMaxIterations
      if (goalMaxMinutes !== undefined) draft.settings.goalMaxMinutes = goalMaxMinutes
      if (agentKernel !== undefined) draft.settings.agentKernel = agentKernel
      if (memoryEnabled !== undefined) draft.settings.memoryEnabled = memoryEnabled
      if (modelProfiles !== undefined) {
        draft.settings.modelProfiles = structuredClone(modelProfiles)
        // Profiles changed: a dangling active id degrades to null.
        if (!draft.settings.modelProfiles.some((profile) => profile.id === draft.settings.activeModelProfileId)) {
          draft.settings.activeModelProfileId = null
        }
      }
      if (activeModelProfileId !== undefined) {
        // A stale id is tolerated as "back to the launch environment".
        draft.settings.activeModelProfileId = activeModelProfileId !== null &&
          draft.settings.modelProfiles.some((profile) => profile.id === activeModelProfileId)
          ? activeModelProfileId : null
      }
      if (enableAutoTitleGeneration !== undefined) draft.settings.enableAutoTitleGeneration = enableAutoTitleGeneration
      if (showMessageTimestamps !== undefined) draft.settings.showMessageTimestamps = showMessageTimestamps
      if (userName !== undefined) draft.settings.userName = userName.trim()
      if (assistantName !== undefined) draft.settings.assistantName = assistantName.trim()
      if (userAvatar !== undefined) draft.settings.userAvatar = userAvatar
      if (assistantAvatar !== undefined) draft.settings.assistantAvatar = assistantAvatar
      if (panelSize !== undefined) draft.settings.panelSize = { width: panelSize.width, height: panelSize.height }
      if (panelPlacement !== undefined) {
        if (!isPanelPlacement(panelPlacement)) throw new ConversationStoreError('INVALID_INPUT', '面板位置无效。')
        draft.settings.panelPlacement = panelPlacement
      }
      if (panelTheme !== undefined) {
        if (!isPanelTheme(panelTheme)) throw new ConversationStoreError('INVALID_INPUT', '面板主题无效。')
        draft.settings.panelTheme = panelTheme
      }
      if (uiSize !== undefined) draft.settings.uiSize = uiSize
      if (avatarSize !== undefined) draft.settings.avatarSize = avatarSize
      if (avatarRenderer !== undefined) draft.settings.avatarRenderer = avatarRenderer
      if (toolRowDetail !== undefined) draft.settings.toolRowDetail = toolRowDetail
      if (personaId !== undefined) draft.settings.personaId = personaId
      if (autoCompactPercent !== undefined) draft.settings.autoCompactPercent = autoCompactPercent
      if (outputStyle !== undefined) {
        const trimmed = outputStyle.trim()
        if (trimmed) draft.settings.outputStyle = trimmed
        else delete draft.settings.outputStyle
      }
      if (appendSystemPrompt !== undefined) {
        const trimmed = appendSystemPrompt.trim()
        if (trimmed) draft.settings.appendSystemPrompt = trimmed
        else delete draft.settings.appendSystemPrompt
      }
      if (autoScroll !== undefined) draft.settings.autoScroll = autoScroll
      if (expandFileEditsByDefault !== undefined) draft.settings.expandFileEditsByDefault = expandFileEditsByDefault
      if (sessionSort !== undefined) draft.settings.sessionSort = sessionSort
      if (titleLocale !== undefined) draft.settings.titleLocale = titleLocale
      if (titleModel !== undefined) {
        const trimmed = titleModel.trim()
        if (trimmed) draft.settings.titleModel = trimmed
        else delete draft.settings.titleModel
      }
      if (loadUserSettings !== undefined) draft.settings.loadUserSettings = loadUserSettings
      return draft.settings
    })
  }

  setConversationPinned(id: string, pinned: boolean): Promise<ConversationLibraryState> {
    if (typeof pinned !== 'boolean') throw new ConversationStoreError('INVALID_INPUT', '置顶状态无效。')
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (record.archivedAt !== null) {
        throw new ConversationStoreError('ARCHIVED_CONVERSATION', '请先恢复归档会话。')
      }
      record.pinnedAt = pinned ? (record.pinnedAt ?? new Date().toISOString()) : null
      return stateOf(draft)
    })
  }

  setTabOrder(ids: string[]): Promise<ConversationLibraryState> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
      throw new ConversationStoreError('INVALID_INPUT', '标签顺序格式无效。')
    }
    return this.mutate((draft) => {
      const known = new Set(draft.conversations.map((record) => record.id))
      const seen = new Set<string>()
      const next: string[] = []
      for (const id of ids) {
        if (known.has(id) && !seen.has(id)) { seen.add(id); next.push(id) }
      }
      // Everything the caller left out keeps a slot at the tail, in the order
      // it already had — a stale renderer must not reshuffle the rest.
      for (const id of draft.settings.tabOrder) {
        if (known.has(id) && !seen.has(id)) { seen.add(id); next.push(id) }
      }
      for (const record of draft.conversations) {
        if (!seen.has(record.id)) next.push(record.id)
      }
      draft.settings.tabOrder = next
      return stateOf(draft)
    })
  }

  async archiveInactiveConversations(
    now: Date = new Date(),
    isBusy: (conversationId: string) => boolean = () => false
  ): Promise<ConversationLibraryState> {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new ConversationStoreError('INVALID_INPUT', '当前时间无效。')
    }
    // Claudian's policy: off by default; age is strict; keep pinned/open sessions.
    // Adapted for our single Electron window and durable pending-message queue.
    // https://github.com/YishenTu/claudian/blob/main/src/features/chat/conversation/InactiveSessionArchiver.ts
    if ((await this.getState()).settings.autoArchiveAfterDays === 0) return this.getState()
    return this.mutate((draft) => {
      const days = draft.settings.autoArchiveAfterDays
      if (!days) return stateOf(draft)
      const cutoff = now.getTime() - days * 86_400_000
      for (const record of draft.conversations) {
        if (record.archivedAt !== null || record.pinnedAt !== null ||
            record.id === draft.activeConversationId || record.pendingMessages.length > 0 ||
            isBusy(record.id)) continue
        const active = Date.parse(record.lastActivityAt ?? record.updatedAt)
        if (Number.isFinite(active) && active < cutoff) record.archivedAt = now.toISOString()
      }
      return stateOf(draft)
    })
  }
}
