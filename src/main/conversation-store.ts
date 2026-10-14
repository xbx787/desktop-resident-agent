import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { DialogueLine } from './deepseek'
import { isEffortLevel } from '../shared/effort'
import { protectProfiles, restoreProfiles, type SecretCodec } from './secret-storage'
import type { AgentGoal, EffortLevel, ModelMode, ModelProfile, TaskStatus, TimelineEntry, UserAttachment, ConversationSettings } from '../shared/contracts'

const DEFAULT_VISIBLE_TABS = 5
const MAX_VISIBLE_TABS = 12
const LEGACY_MAX_ACTIVE_LIMIT = 50
const DEFAULT_TITLE = '新对话'

/** The store and the renderer share one definition of the settings shape;
 *  this re-export keeps the historical import path working. */
export type { ConversationSettings }

export interface PendingMessage {
  id: string
  text: string
  attachments: UserAttachment[]
  createdAt: string
  /** Frozen at submit time; only the main process uses this model context. */
  sessionContext?: string
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
  goal?: AgentGoal | null
  compactionSummary?: string
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

export interface ConversationPatch {
  title?: string
  mode?: ModelMode
  taskStatus?: TaskStatus
  timeline?: TimelineEntry[]
  history?: DialogueLine[]
  pendingMessages?: PendingMessage[]
  sdkSessionId?: string | null
  goal?: AgentGoal | null
  compactionSummary?: string | null
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
    (value.goal === undefined || isGoal(value.goal)) &&
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
    (value.extraEnv === undefined || typeof value.extraEnv === 'string')
}

/** The settings that arrived after version 2 shipped: read leniently so an
 *  older file simply gets the defaults instead of failing to load. */
function readExtendedSettings(settings: Record<string, unknown>): Pick<ConversationSettings,
  'modelProfiles' | 'activeModelProfileId' | 'enableAutoTitleGeneration' | 'showMessageTimestamps' |
  'userName' | 'assistantName' | 'userAvatar' | 'assistantAvatar' | 'tabOrder' |
  'goalMaxIterations' | 'goalMaxMinutes' | 'memoryEnabled'> {
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
    goalMaxMinutes: Number.isInteger(settings.goalMaxMinutes) && Number(settings.goalMaxMinutes) >= 1 && Number(settings.goalMaxMinutes) <= 1440 ? Number(settings.goalMaxMinutes) : 180,
    memoryEnabled: settings.memoryEnabled !== false
  }
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
      conversations: records.map((record) => ({ ...record, pinnedAt: record.pinnedAt ?? null,
        pendingMessages: record.pendingMessages ?? [], taskStatus: restoredTaskStatus(record.taskStatus), goal: record.goal ?? null }))
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

function compareByRecent(a: ConversationRecord, b: ConversationRecord): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
}

function compareForList(a: ConversationRecord, b: ConversationRecord): number {
  const scopeOrder = Number(a.archivedAt !== null) - Number(b.archivedAt !== null)
  if (scopeOrder !== 0) return scopeOrder
  if (a.archivedAt !== null) return compareByRecent(a, b)
  return Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) || compareByRecent(a, b)
}

function summaries(records: ConversationRecord[], options: ConversationSearchOptions = {}): ConversationSummary[] {
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  return records
    .filter((record) => options.archived === undefined || (record.archivedAt !== null) === options.archived)
    .filter((record) => !query || record.title.toLocaleLowerCase().includes(query) ||
      record.timeline.some((entry) => entry.text.toLocaleLowerCase().includes(query)) ||
      record.history.some((line) => line.content.toLocaleLowerCase().includes(query)))
    .sort(compareForList)
    .map((record) => ({
      id: record.id,
      title: record.title,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      archivedAt: record.archivedAt,
      pinnedAt: record.pinnedAt,
      mode: record.mode,
      taskStatus: record.taskStatus,
      messageCount: record.timeline.filter((entry) => entry.kind === 'user' || entry.kind === 'assistant').length,
      preview: [...record.timeline].reverse().find((entry) => entry.kind === 'user' || entry.kind === 'assistant')?.text.slice(0, 160) ?? ''
    }))
}

function stateOf(library: PersistedLibrary): ConversationLibraryState {
  return {
    settings: structuredClone(library.settings),
    activeConversationId: library.activeConversationId,
    conversations: summaries(library.conversations)
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

export class ConversationStore {
  readonly filePath: string
  private library: PersistedLibrary | null = null
  private initialization: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()

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

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      const parsed = parseLibrary(await fs.readFile(this.filePath, 'utf8'))
      const restored = this.secretCodec
        ? restoreProfiles(parsed.library.settings.modelProfiles, this.secretCodec)
        : { profiles: parsed.library.settings.modelProfiles, changed: false }
      parsed.library.settings.modelProfiles = restored.profiles
      if (parsed.migrated || restored.changed) await this.persist(parsed.library)
      this.library = parsed.library
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error
      const initial: PersistedLibrary = {
        version: 2,
        settings: { visibleConversationTabs: DEFAULT_VISIBLE_TABS, autoArchiveAfterDays: 0, effort: 'max',
          modelProfiles: [], activeModelProfileId: null, enableAutoTitleGeneration: true, showMessageTimestamps: true,
          userName: '主人', assistantName: '小鲸', userAvatar: null, assistantAvatar: null, tabOrder: [],
          goalMaxIterations: 30, goalMaxMinutes: 180, memoryEnabled: true },
        activeConversationId: null,
        conversations: []
      }
      await this.persist(initial)
      this.library = initial
    }
  }

  private async persist(library: PersistedLibrary): Promise<void> {
    const temporary = path.join(path.dirname(this.filePath), `.library.${process.pid}.${randomUUID()}.tmp`)
    try {
      const diskLibrary = structuredClone(library)
      if (this.secretCodec) diskLibrary.settings.modelProfiles = protectProfiles(diskLibrary.settings.modelProfiles, this.secretCodec)
      const file = await fs.open(temporary, 'wx')
      try {
        await file.writeFile(JSON.stringify(diskLibrary, null, 2) + '\n', 'utf8')
        await file.sync()
      } finally {
        await file.close()
      }
      await fs.rename(temporary, this.filePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
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
    return summaries(this.library!.conversations, options)
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
    return this.mutate((draft) => {
      const now = new Date().toISOString()
      const record: ConversationRecord = {
        id: randomUUID(), title: clean, createdAt: now, updatedAt: now,
        archivedAt: null, pinnedAt: null, mode, taskStatus: 'idle', timeline: [], history: [], pendingMessages: [], sdkSessionId: null, goal: null
      }
      draft.conversations.push(record)
      // A new session is what the user is about to use — it leads the row.
      draft.settings.tabOrder.unshift(record.id)
      draft.activeConversationId = record.id
      return record
    })
  }

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
    if (changes.goal !== undefined && !isGoal(changes.goal)) {
      throw new ConversationStoreError('INVALID_INPUT', '目标状态格式无效。')
    }
    if (changes.compactionSummary !== undefined && changes.compactionSummary !== null && typeof changes.compactionSummary !== 'string') {
      throw new ConversationStoreError('INVALID_INPUT', '上下文摘要格式无效。')
    }
    return this.mutate((draft) => {
      const record = findRecord(draft, id)
      if (changes.title !== undefined) record.title = changes.title
      if (changes.mode !== undefined) record.mode = changes.mode
      if (changes.taskStatus !== undefined) record.taskStatus = changes.taskStatus
      if (changes.timeline !== undefined) record.timeline = changes.timeline
      if (changes.history !== undefined) record.history = changes.history
      if (changes.pendingMessages !== undefined) record.pendingMessages = changes.pendingMessages
      if (changes.sdkSessionId !== undefined) record.sdkSessionId = changes.sdkSessionId
      if (changes.goal !== undefined) record.goal = changes.goal
      if (changes.compactionSummary === null) delete record.compactionSummary
      else if (changes.compactionSummary !== undefined) record.compactionSummary = changes.compactionSummary
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

  async updateSettings(patch: Partial<ConversationSettings>): Promise<ConversationSettings> {
    const tabs = patch.visibleConversationTabs
    const autoArchive = patch.autoArchiveAfterDays
    const effort = patch.effort
    const modelProfiles = patch.modelProfiles
    const activeModelProfileId = patch.activeModelProfileId
    const { goalMaxIterations, goalMaxMinutes, memoryEnabled } = patch
    const { enableAutoTitleGeneration, showMessageTimestamps, userName, assistantName, userAvatar, assistantAvatar } = patch
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
    if (goalMaxMinutes !== undefined && (!Number.isInteger(goalMaxMinutes) || goalMaxMinutes < 1 || goalMaxMinutes > 1440)) {
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
    return this.mutate((draft) => {
      if (tabs !== undefined) draft.settings.visibleConversationTabs = tabs
      if (autoArchive !== undefined) draft.settings.autoArchiveAfterDays = autoArchive
      if (effort !== undefined) draft.settings.effort = effort
      if (goalMaxIterations !== undefined) draft.settings.goalMaxIterations = goalMaxIterations
      if (goalMaxMinutes !== undefined) draft.settings.goalMaxMinutes = goalMaxMinutes
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

  async archiveInactiveConversations(now: Date = new Date()): Promise<ConversationLibraryState> {
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
            record.id === draft.activeConversationId || record.pendingMessages.length > 0) continue
        const updated = Date.parse(record.updatedAt)
        if (Number.isFinite(updated) && updated < cutoff) record.archivedAt = now.toISOString()
      }
      return stateOf(draft)
    })
  }
}
