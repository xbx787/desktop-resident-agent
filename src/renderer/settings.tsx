import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { AgentCapabilities, ConversationSettings, GrowthProposal, ModelProfile } from '../shared/contracts'
import { LIBRARY_KINDS, LIBRARY_LABELS, LIBRARY_MARKET_LABELS, type LibraryItem, type LibraryKind, type LibrarySnapshot } from '../shared/libraries'
import { PERSONA_PRESETS } from '../shared/personas'
import { personaAvatarUrl } from './avatar-art'
import { PROVIDER_CATALOG } from '../shared/provider-catalog'
import { DEFAULT_SKILL_MARKET_SOURCES, SKILL_MARKET_SOURCES } from '../shared/skill-market'
import { publicErrorText } from '../shared/error-copy'
import type { GrowthOverview, SettingsAPI } from '../preload/settings'
import type { MemoryItem } from '../main/memory-service'
import { SettingsVoiceSection } from './settings-voice'
import './settings.css'
import './voice.css'

declare global {
  interface Window {
    whaleSettings: SettingsAPI
  }
}

function errorMessage(cause: unknown): string {
  return publicErrorText(cause instanceof Error ? cause.message : String(cause))
}

/** The model form's local draft; a catalog pick fills the fields, a custom
 *  pick leaves them to the user. */
interface ModelFormState {
  id: string | null
  providerId: string
  modelId: string
  name: string
  baseUrl: string
  apiKey: string
  smallModel: string
  extraEnv: string
  removeExtraEnv: boolean
  advanced: boolean
  /** 端点返回的模型 id；搜索框过滤它，点一下就填进模型 ID。 */
  discovered: string[]
  modelSearch: string
}

const BASE_SETTINGS_TABS = [
  { id: 'conversation', label: '对话' },
  { id: 'appearance', label: '外观' },
  { id: 'libraries', label: '库' },
  { id: 'models', label: '模型' },
  { id: 'voice', label: '语音' },
  { id: 'memory', label: '记忆' },
  { id: 'identity', label: '称呼' },
  { id: 'avatar', label: '人设' }
] as const
type SettingsTab = typeof BASE_SETTINGS_TABS[number]['id'] | 'growth'
/** Growth experiments stay a local development tool; the packaged build
 *  ships the stable tab set only. */
const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTab; label: string }> = [
  ...BASE_SETTINGS_TABS,
  ...(import.meta.env.MODE === 'development' ? [{ id: 'growth' as const, label: '成长' }] : [])
]

/** 界面尺寸档：小是原来的样子，中、大各上调一档。 */
const UI_SIZE_OPTIONS: ReadonlyArray<{ id: ConversationSettings['uiSize']; label: string }> = [
  { id: 'small', label: '小' },
  { id: 'medium', label: '中' },
  { id: 'large', label: '大' }
]

/** 人物大小档：小 = 现在，中 = 之前的尺寸，大 = 再上一档。 */
const AVATAR_SIZE_OPTIONS: ReadonlyArray<{ id: ConversationSettings['avatarSize']; label: string }> = [
  { id: 'small', label: '小' },
  { id: 'medium', label: '中' },
  { id: 'large', label: '大' }
]

const GROWTH_STATUS_LABEL: Record<GrowthProposal['status'], string> = {
  proposed: '待同意实验', running: '实验中', ready: '待审阅', failed: '实验失败',
  stale: '源码已变化', adopted: '已在本机采纳', published: '已发布 GitHub', discarded: '已丢弃'
}

function dateLabel(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

export function SettingsPage() {
  const [settings, setSettings] = useState<ConversationSettings | null>(null)
  const [tabsDraft, setTabsDraft] = useState('5')
  const [goalIterationsDraft, setGoalIterationsDraft] = useState('30')
  const [goalMinutesDraft, setGoalMinutesDraft] = useState('180')
  const [appendPromptDraft, setAppendPromptDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const [capabilities, setCapabilities] = useState<AgentCapabilities | null>(null)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [userNameDraft, setUserNameDraft] = useState('')
  const [assistantNameDraft, setAssistantNameDraft] = useState('')
  const [avatars, setAvatars] = useState<{ user: string | null; assistant: string | null }>({ user: null, assistant: null })
  const [modelForm, setModelForm] = useState<ModelFormState | null>(null)
  const [modelTest, setModelTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelTesting, setModelTesting] = useState(false)
  const [modelDiscovering, setModelDiscovering] = useState(false)
  const [modelDiscoverMessage, setModelDiscoverMessage] = useState('')
  const [profileDeleteId, setProfileDeleteId] = useState<string | null>(null)
  const [memoryItems, setMemoryItems] = useState<MemoryItem[]>([])
  const [memoryLoading, setMemoryLoading] = useState(false)
  const [memoryBusyId, setMemoryBusyId] = useState<string | null>(null)
  const [memoryEditId, setMemoryEditId] = useState<string | null>(null)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [growth, setGrowth] = useState<GrowthOverview | null>(null)
  const [growthBusyId, setGrowthBusyId] = useState<string | null>(null)
  const [growthSelectedId, setGrowthSelectedId] = useState<string | null>(null)
  const [growthNotesDraft, setGrowthNotesDraft] = useState('')
  const [growthFormOpen, setGrowthFormOpen] = useState(false)
  const [growthTitle, setGrowthTitle] = useState('')
  const [growthObjective, setGrowthObjective] = useState('')
  const [growthEvidence, setGrowthEvidence] = useState('')
  const [tab, setTab] = useState<SettingsTab>('conversation')
  const [workspace, setWorkspace] = useState<{ path: string; saved: boolean } | null>(null)
  const [workspacePending, setWorkspacePending] = useState<string | null>(null)
  const [workspaceBusy, setWorkspaceBusy] = useState(false)
  const [quitAction, setQuitAction] = useState<'quit' | 'restart' | null>(null)
  const [libraries, setLibraries] = useState<LibrarySnapshot>({ items: [], busy: false })
  const [libraryKind, setLibraryKind] = useState<LibraryKind>('mcp')
  const [marketQuery, setMarketQuery] = useState('')
  const [marketItems, setMarketItems] = useState<LibraryItem[]>([])
  const [marketBusy, setMarketBusy] = useState(false)
  const [marketError, setMarketError] = useState('')
  const [marketLoadedFor, setMarketLoadedFor] = useState<LibraryKind | null>(null)
  const [libraryBusyId, setLibraryBusyId] = useState<string | null>(null)
  const [libraryHealthBusyId, setLibraryHealthBusyId] = useState<string | null>(null)
  const [libraryHealth, setLibraryHealth] = useState<Record<string, { ok: boolean; message: string }>>({})

  useEffect(() => {
    let active = true
    void window.whaleSettings.version().then((current) => {
      if (active) setVersion(current)
    }).catch(() => undefined)
    void window.whaleSettings.capabilities?.().then((current) => {
      if (active) setCapabilities(current)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    let active = true
    void window.whaleSettings.get().then((current) => {
      if (!active) return
      setSettings(current)
      setTabsDraft(String(current.visibleConversationTabs))
      setGoalIterationsDraft(String(current.goalMaxIterations))
      setGoalMinutesDraft(String(current.goalMaxMinutes))
      setUserNameDraft(current.userName)
      setAssistantNameDraft(current.assistantName)
      setAppendPromptDraft(current.appendSystemPrompt ?? '')
    }).catch((cause: unknown) => {
      if (active) setNotice({ text: errorMessage(cause), error: true })
    })
    void Promise.all([window.whaleSettings.readAvatar('user'), window.whaleSettings.readAvatar('assistant')])
      .then(([user, assistant]) => { if (active) setAvatars({ user, assistant }) })
      .catch(() => undefined)
    void window.whaleSettings.workspace()
      .then((current) => { if (active) setWorkspace(current) })
      .catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (tab !== 'memory') return
    let active = true
    setMemoryLoading(true)
    void window.whaleSettings.memoryList().then((items) => {
      if (active) setMemoryItems(items)
    }).catch((cause: unknown) => {
      if (active) setNotice({ text: errorMessage(cause), error: true })
    }).finally(() => { if (active) setMemoryLoading(false) })
    return () => { active = false }
  }, [tab])

  useEffect(() => {
    if (tab !== 'libraries') return
    let active = true
    void window.whaleSettings.libraries().then((current) => {
      if (active) setLibraries(current)
    }).catch((cause: unknown) => {
      if (active) setNotice({ text: errorMessage(cause), error: true })
    })
    return () => { active = false }
  }, [tab])

  useEffect(() => {
    if (tab !== 'libraries') return
    let active = true
    setMarketBusy(true)
    setMarketError('')
    setMarketItems([])
    void window.whaleSettings.searchLibraryMarket(libraryKind, '').then((items) => {
      if (!active) return
      setMarketItems(items)
      setMarketLoadedFor(libraryKind)
    }).catch((cause: unknown) => {
      if (active) setMarketError(errorMessage(cause))
    }).finally(() => {
      if (active) setMarketBusy(false)
    })
    return () => { active = false }
  }, [tab, libraryKind, settings?.skillMarketSources?.join(',')])

  useEffect(() => {
    // 成长实验不在设置里暴露：面板入口已移除，这段轮询永远不会启动。
    // 数据仍由主进程写进本地 data/growth/（见 GrowthStore 的 proposals.md）。
    if ((tab as string) !== 'growth') return
    let active = true
    const refresh = (): void => {
      void window.whaleSettings.growthStatus().then((current) => {
        if (active) setGrowth(current)
      }).catch((cause: unknown) => {
        if (active) setNotice({ text: errorMessage(cause), error: true })
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 5_000)
    return () => { active = false; window.clearInterval(timer) }
  }, [tab])

  const installedLibraries = libraries.items.filter((item) => item.kind === libraryKind)
  const selectedGrowth = growth?.proposals.find((item) => item.id === growthSelectedId && item.status !== 'discarded') ?? growth?.proposals.find((item) => item.status !== 'discarded') ?? null
  useEffect(() => {
    setGrowthNotesDraft(selectedGrowth?.releaseNotes ?? '')
  }, [selectedGrowth?.id, selectedGrowth?.releaseNotes])

  async function searchLibraryMarket(): Promise<void> {
    if (marketBusy) return
    setMarketBusy(true)
    setMarketError('')
    try {
      setMarketItems(await window.whaleSettings.searchLibraryMarket(libraryKind, marketQuery))
      setMarketLoadedFor(libraryKind)
    } catch (cause) {
      setMarketError(errorMessage(cause))
    } finally {
      setMarketBusy(false)
    }
  }

  function toggleSkillSource(id: string, on: boolean): void {
    const current = settings?.skillMarketSources ?? [...DEFAULT_SKILL_MARKET_SOURCES]
    const next = on ? [...new Set([...current, id])] : current.filter((item) => item !== id)
    setMarketItems([])
    setMarketLoadedFor(null)
    setMarketError('')
    void update({ skillMarketSources: next })
  }

  async function installLibraryItem(item: LibraryItem): Promise<void> {
    if (libraryBusyId) return
    setLibraryBusyId(item.id)
    setMarketError('')
    try {
      setLibraries(await window.whaleSettings.installLibrary(item))
      setNotice({ text: `已添加 ${item.name}，可在对话里用 @ 使用。`, error: false })
    } catch (cause) {
      setMarketError(errorMessage(cause))
    } finally {
      setLibraryBusyId(null)
    }
  }

  async function removeLibraryItem(item: LibraryItem): Promise<void> {
    if (libraryBusyId) return
    setLibraryBusyId(item.id)
    try {
      setLibraries(await window.whaleSettings.removeLibrary(item.id))
      setNotice({ text: `已移除 ${item.name}。`, error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setLibraryBusyId(null)
    }
  }

  async function toggleLibraryItem(item: LibraryItem): Promise<void> {
    if (libraryBusyId || !window.whaleSettings.setLibraryEnabled) return
    setLibraryBusyId(item.id)
    try {
      setLibraries(await window.whaleSettings.setLibraryEnabled(item.id, item.disabled === true))
      setNotice({ text: item.disabled ? `已启用 ${item.name}。` : `已停用 ${item.name}。`, error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setLibraryBusyId(null)
    }
  }

  async function checkLibraryItem(item: LibraryItem): Promise<void> {
    if (libraryHealthBusyId || !window.whaleSettings.probeLibrary) return
    setLibraryHealthBusyId(item.id)
    try {
      const result = await window.whaleSettings.probeLibrary(item.id)
      setLibraryHealth((current) => ({ ...current, [item.id]: result }))
    } catch (cause) {
      setLibraryHealth((current) => ({ ...current, [item.id]: { ok: false, message: errorMessage(cause) } }))
    } finally {
      setLibraryHealthBusyId(null)
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (workspaceBusy) return
    setNotice(null)
    try {
      const picked = await window.whaleSettings.pickWorkspace()
      if (picked && picked !== workspace?.path) setWorkspacePending(picked)
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    }
  }

  async function migrateWorkspace(): Promise<void> {
    if (!workspacePending || workspaceBusy) return
    setWorkspaceBusy(true)
    setNotice(null)
    try {
      const next = await window.whaleSettings.migrateWorkspace(workspacePending)
      setWorkspace({ path: next.path, saved: true })
      setWorkspacePending(null)
      setNotice({ text: `工作目录已迁移到 ${next.path}`, error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setWorkspaceBusy(false)
    }
  }

  async function update(patch: Partial<ConversationSettings>): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const current = await window.whaleSettings.update(patch)
      setSettings(current)
      setTabsDraft(String(current.visibleConversationTabs))
      setGoalIterationsDraft(String(current.goalMaxIterations))
      setGoalMinutesDraft(String(current.goalMaxMinutes))
      setAppendPromptDraft(current.appendSystemPrompt ?? '')
      setNotice({ text: '已保存', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  function saveTabs(): void {
    const value = Number(tabsDraft)
    if (!Number.isInteger(value) || value < 1 || value > 12) {
      setNotice({ text: '快捷标签数量应为 1–12。', error: true })
      return
    }
    if (value === settings?.visibleConversationTabs) return
    void update({ visibleConversationTabs: value })
  }

  function saveAppendPrompt(): void {
    const next = appendPromptDraft.trim()
    if (next === (settings?.appendSystemPrompt ?? '')) return
    void update({ appendSystemPrompt: next })
  }

  function saveGoalBudget(): void {
    const goalMaxIterations = Number(goalIterationsDraft)
    const goalMaxMinutes = Number(goalMinutesDraft)
    if (!Number.isInteger(goalMaxIterations) || goalMaxIterations < 1 || goalMaxIterations > 300 ||
      !Number.isInteger(goalMaxMinutes) || goalMaxMinutes < 0 || goalMaxMinutes > 1440) {
      setNotice({ text: '目标轮数应为 1–300，时长应为 1–1440 分钟。', error: true })
      return
    }
    if (goalMaxIterations === settings?.goalMaxIterations && goalMaxMinutes === settings.goalMaxMinutes) return
    void update({ goalMaxIterations, goalMaxMinutes })
  }

  async function setMemoryEnabled(enabled: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const saved = await window.whaleSettings.memorySetEnabled(enabled)
      setSettings((current) => current ? { ...current, memoryEnabled: saved } : current)
      setNotice({ text: saved ? '长期记忆已开启' : '长期记忆已关闭，已保存的记忆仍可管理', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function saveMemory(): Promise<void> {
    if (!memoryEditId || memoryBusyId) return
    const text = memoryDraft.trim()
    if (!text) { setNotice({ text: '记忆内容不能为空。', error: true }); return }
    setMemoryBusyId(memoryEditId)
    setNotice(null)
    try {
      const saved = await window.whaleSettings.memoryUpdate(memoryEditId, text)
      setMemoryItems((current) => current.map((item) => item.id === saved.id ? saved : item))
      setMemoryEditId(null)
      setNotice({ text: '记忆已更新，下一轮对话即可使用', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setMemoryBusyId(null)
    }
  }

  async function deleteMemory(id: string): Promise<void> {
    if (memoryBusyId) return
    setMemoryBusyId(id)
    setNotice(null)
    try {
      await window.whaleSettings.memoryDelete(id)
      setMemoryItems((current) => current.filter((item) => item.id !== id))
      if (memoryEditId === id) setMemoryEditId(null)
      setNotice({ text: '记忆已删除', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setMemoryBusyId(null)
    }
  }

  async function growthAction(id: string, action: () => Promise<GrowthProposal>, success: string): Promise<void> {
    if (growthBusyId) return
    setGrowthBusyId(id)
    setNotice(null)
    try {
      const result = await action()
      setGrowth((current) => current ? {
        ...current, proposals: current.proposals.map((item) => item.id === id ? result : item)
      } : current)
      if (result.status === 'failed') setNotice({ text: result.error ?? '实验未通过检查。', error: true })
      else setNotice({ text: success, error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setGrowthBusyId(null)
    }
  }

  async function proposeGrowth(): Promise<void> {
    if (growthBusyId || !growthTitle.trim() || !growthObjective.trim() || !growthEvidence.trim()) return
    setGrowthBusyId('new')
    setNotice(null)
    try {
      const item = await window.whaleSettings.growthPropose(growthTitle, growthObjective, growthEvidence)
      setGrowth((current) => current ? { ...current, proposals: [item, ...current.proposals.filter((old) => old.id !== item.id)] } : current)
      setGrowthSelectedId(item.id)
      setGrowthFormOpen(false)
      setGrowthTitle('')
      setGrowthObjective('')
      setGrowthEvidence('')
      setNotice({ text: '改进建议已记录，实验需单独同意', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setGrowthBusyId(null)
    }
  }

  /** Commits both names; empty input falls back to the saved value. */
  function saveNames(): void {
    if (!settings) return
    const userName = userNameDraft.trim() || settings.userName
    const assistantName = assistantNameDraft.trim() || settings.assistantName
    setUserNameDraft(userName)
    setAssistantNameDraft(assistantName)
    if (userName === settings.userName && assistantName === settings.assistantName) return
    void update({ userName, assistantName })
  }

  function openAddModel(): void {
    const provider = PROVIDER_CATALOG[0]
    setModelTest(null)
    setModelDiscoverMessage('')
    setProfileDeleteId(null)
    setModelForm({ id: null, providerId: provider.id, modelId: provider.models[0].id, name: provider.name,
      baseUrl: provider.baseUrl, apiKey: '', smallModel: provider.smallModel ?? '', extraEnv: '', removeExtraEnv: false, advanced: false,
      discovered: [], modelSearch: '' })
  }

  function openEditModel(profile: ModelProfile): void {
    const provider = PROVIDER_CATALOG.find((item) => item.baseUrl === profile.baseUrl && item.models.some((model) => model.id === profile.model))
    setModelTest(null)
    setModelDiscoverMessage('')
    setProfileDeleteId(null)
    setModelForm({ id: profile.id, providerId: provider?.id ?? 'custom', modelId: profile.model, name: profile.name,
      baseUrl: profile.baseUrl, apiKey: '', smallModel: profile.smallModel ?? '', extraEnv: '', removeExtraEnv: false, advanced: Boolean(profile.extraEnvConfigured),
      discovered: [], modelSearch: '' })
  }

  function pickModelProvider(providerId: string): void {
    if (!modelForm) return
    if (providerId === 'custom') { setModelForm({ ...modelForm, providerId, name: '自定义' }); return }
    const provider = PROVIDER_CATALOG.find((item) => item.id === providerId)!
    setModelForm({ ...modelForm, providerId, modelId: provider.models[0].id, name: provider.name,
      baseUrl: provider.baseUrl, smallModel: provider.smallModel ?? modelForm.smallModel })
  }

  /** The draft as a wire profile; null while a required field is empty. */
  function draftModel(): ModelProfile | null {
    if (!modelForm) return null
    const name = modelForm.name.trim()
    const baseUrl = modelForm.baseUrl.trim().replace(/\/+$/, '')
    const apiKey = modelForm.apiKey.trim()
    const model = modelForm.modelId.trim()
    const saved = settings?.modelProfiles.find((profile) => profile.id === modelForm.id)
    if (!name || !baseUrl || (!apiKey && !(saved?.apiKeyConfigured && saved.baseUrl === baseUrl)) || !model) return null
    return {
      id: modelForm.id ?? crypto.randomUUID(),
      name, baseUrl, apiKey, model,
      enabled: saved?.enabled ?? true,
      ...(modelForm.smallModel.trim() ? { smallModel: modelForm.smallModel.trim() } : {}),
      ...(modelForm.extraEnv.trim() ? { extraEnv: modelForm.extraEnv } : modelForm.removeExtraEnv ? { extraEnv: '' } : {})
    }
  }

  async function saveModel(): Promise<void> {
    const profile = draftModel()
    if (!profile || busy) return
    setBusy(true)
    setNotice(null)
    try {
      await window.whaleSettings.saveModelProfile(profile)
      setSettings(await window.whaleSettings.get())
      setModelForm(null)
      setNotice({ text: '已保存', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function probeModel(): Promise<void> {
    const profile = draftModel()
    if (!profile || modelTesting) return
    setModelTesting(true)
    try {
      setModelTest(await window.whaleSettings.testModelProfile(profile))
    } catch (cause) {
      setModelTest({ ok: false, message: errorMessage(cause) })
    } finally {
      setModelTesting(false)
    }
  }

  async function discoverModels(): Promise<void> {
    if (!modelForm || modelDiscovering) return
    const profile = draftModel()
    if (!profile) {
      setModelDiscoverMessage('先填好端点、模型 ID 和 API Key，再拉取模型列表。')
      return
    }
    setModelDiscovering(true)
    setModelDiscoverMessage('')
    try {
      if (!window.whaleSettings.discoverModels) throw new Error('当前版本不支持模型发现。')
      const result = await window.whaleSettings.discoverModels(profile)
      setModelDiscoverMessage(result.message)
      if (result.ok) setModelForm((current) => current ? { ...current, discovered: result.models } : current)
    } catch (cause) {
      setModelDiscoverMessage(errorMessage(cause))
    } finally {
      setModelDiscovering(false)
    }
  }

  async function toggleModelProfile(profile: ModelProfile): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      if (!window.whaleSettings.setModelProfileEnabled) throw new Error('当前版本不支持停用模型配置。')
      await window.whaleSettings.setModelProfileEnabled(profile.id, profile.enabled === false)
      setSettings(await window.whaleSettings.get())
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function deleteModel(id: string): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      await window.whaleSettings.deleteModelProfile(id)
      setSettings(await window.whaleSettings.get())
      setProfileDeleteId(null)
      if (modelForm?.id === id) setModelForm(null)
      setNotice({ text: '已删除', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function pickAvatar(kind: 'user' | 'assistant', file: File | undefined): Promise<void> {
    if (!file || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const bytes = Array.from(new Uint8Array(await file.arrayBuffer()))
      await window.whaleSettings.setAvatar(kind, bytes)
      const url = await window.whaleSettings.readAvatar(kind)
      setAvatars((current) => ({ ...current, [kind]: url }))
      setNotice({ text: '已保存', error: false })
    } catch (cause) {
      setNotice({ text: errorMessage(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  return <div className="settings-window">
    <header className="settings-header">
      <span className="settings-mark" aria-hidden="true">鲸</span>
      <div><p>{settings?.assistantName ?? '小鲸'}</p><h1>设置</h1></div>
      {version && <span className="settings-version">v{version}</span>}
      <button type="button" className="settings-close" aria-label="关闭设置" title="关闭" onClick={() => { void window.whaleSettings.close(); }}>×</button>
    </header>
    <nav className="settings-tabs" role="tablist" aria-label="设置栏目" onKeyDown={(event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
      event.preventDefault()
      const index = SETTINGS_TABS.findIndex((item) => item.id === tab)
      const next = SETTINGS_TABS[(index + (event.key === 'ArrowRight' ? 1 : SETTINGS_TABS.length - 1)) % SETTINGS_TABS.length]
      setTab(next.id)
      document.getElementById(`settings-tab-${next.id}`)?.focus()
    }}>
      {SETTINGS_TABS.map((item) => <button key={item.id} type="button" role="tab" id={`settings-tab-${item.id}`}
        aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`}
        tabIndex={tab === item.id ? 0 : -1}
        className={`settings-tab${tab === item.id ? ' is-active' : ''}`}
        onClick={() => setTab(item.id)}>{item.label}</button>)}
    </nav>
    <main>
      {tab === 'conversation' && <section className="settings-section" role="tabpanel" id="settings-panel-conversation" aria-labelledby="settings-tab-conversation">
        <div className="settings-row settings-workspace-row">
          <div className="settings-copy">
            <label>工作目录</label>
            <p>小鲸读写和搜索文件都从这个目录开始。迁移不会移动旧目录里的文件，已有对话不受影响，下一条消息会在新目录里处理。</p>
            <code className="settings-workspace-path">{workspace?.path ?? '读取中…'}</code>
          </div>
          <button type="button" disabled={!workspace || workspaceBusy} onClick={() => { void chooseWorkspace(); }}>
            {workspaceBusy ? '迁移中…' : '迁移工作目录…'}
          </button>
        </div>
        {workspacePending && <div className="settings-workspace-confirm" role="alertdialog" aria-label="确认迁移工作目录">
          <p>将工作目录迁移到 <code>{workspacePending}</code>？</p>
          <p>之后的消息在新目录中工作；请先等正在运行的任务完成再迁移；旧目录里的文件保持原样。</p>
          <div className="settings-workspace-confirm-actions">
            <button type="button" disabled={workspaceBusy} onClick={() => setWorkspacePending(null)}>取消</button>
            <button type="button" disabled={workspaceBusy} onClick={() => { void migrateWorkspace(); }}>确认迁移</button>
          </div>
        </div>}
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="visible-tabs">顶部快捷标签</label><p>放大聊天窗口时显示最近的会话。会话总数不受限制。</p></div>
          <form onSubmit={(event) => { event.preventDefault(); saveTabs() }}>
            <input id="visible-tabs" type="number" min="1" max="12" step="1" value={tabsDraft} disabled={!settings || busy} onChange={(event) => setTabsDraft(event.target.value)} />
            <button type="submit" disabled={!settings || busy || tabsDraft === String(settings.visibleConversationTabs)}>应用</button>
          </form>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="auto-archive-days">闲置会话自动归档</label><p>归档保留完整记录，可在会话列表恢复。</p></div>
          <select id="auto-archive-days" value={settings?.autoArchiveAfterDays ?? 0} disabled={!settings || busy} onChange={(event) => { void update({ autoArchiveAfterDays: Number(event.target.value) as ConversationSettings['autoArchiveAfterDays'] }) }}>
            <option value={0}>关闭</option><option value={7}>7 天</option><option value={14}>14 天</option><option value={30}>30 天</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label id="auto-title-label">标题自动生成</label><p>首行标题始终会写；关闭后不再请模型润色。</p></div>
          <button type="button" role="switch" aria-labelledby="auto-title-label" aria-checked={settings?.enableAutoTitleGeneration ?? true}
            className={`settings-switch${settings?.enableAutoTitleGeneration ?? true ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void update({ enableAutoTitleGeneration: !(settings?.enableAutoTitleGeneration ?? true) }) }} />
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label id="timestamps-label">消息时间戳</label><p>每条消息旁显示时间。</p></div>
          <button type="button" role="switch" aria-labelledby="timestamps-label" aria-checked={settings?.showMessageTimestamps ?? true}
            className={`settings-switch${settings?.showMessageTimestamps ?? true ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void update({ showMessageTimestamps: !(settings?.showMessageTimestamps ?? true) }) }} />
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label id="load-user-settings-label">加载 Claude 用户设置</label><p>读取 ~/.claude 里的权限、hooks 和输出风格；关闭后只使用项目和本应用设置。</p></div>
          <button type="button" role="switch" aria-labelledby="load-user-settings-label" aria-checked={settings?.loadUserSettings !== false}
            className={`settings-switch${settings?.loadUserSettings !== false ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void update({ loadUserSettings: !(settings?.loadUserSettings !== false) }) }} />
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="output-style">回答风格</label><p>Claude 的正式回答风格；修改后下一轮会用新风格开始模型会话。</p></div>
          <select id="output-style" className="settings-wide-select" value={settings?.outputStyle ?? ''} disabled={!settings || busy}
            onChange={(event) => { void update({ outputStyle: event.target.value }) }}>
            <option value="">跟随 CLI 默认</option>
            <option value="default">默认</option>
            <option value="Explanatory">解释型</option>
            <option value="Learning">学习型</option>
            {settings?.outputStyle && !['default', 'Explanatory', 'Learning'].includes(settings.outputStyle) &&
              <option value={settings.outputStyle}>{settings.outputStyle}</option>}
          </select>
        </div>
        <div className="settings-row settings-prompt-row">
          <div className="settings-copy"><label htmlFor="append-prompt">附加指令</label><p>追加在人设之后，用来约束回答方式或补充项目约定。修改后下一条消息开始新的模型会话。</p></div>
          <form onSubmit={(event) => { event.preventDefault(); saveAppendPrompt() }}>
            <textarea id="append-prompt" rows={4} maxLength={4000} value={appendPromptDraft} disabled={!settings || busy}
              placeholder="例如：回答先给结论，代码改动保持最小。"
              onChange={(event) => setAppendPromptDraft(event.target.value)} />
            <button type="submit" disabled={!settings || busy || appendPromptDraft.trim() === (settings?.appendSystemPrompt ?? '')}>应用</button>
          </form>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label id="auto-scroll-label">自动跟随</label><p>新内容到达时自动滚到最新；关闭后可用回到底部键。</p></div>
          <button type="button" role="switch" aria-labelledby="auto-scroll-label" aria-checked={settings?.autoScroll ?? true}
            className={`settings-switch${settings?.autoScroll ?? true ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void update({ autoScroll: !(settings?.autoScroll ?? true) }) }} />
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label id="expand-edits-label">默认展开文件编辑</label><p>编辑类工具行打开时直接显示改动，不用再点一次。</p></div>
          <button type="button" role="switch" aria-labelledby="expand-edits-label" aria-checked={settings?.expandFileEditsByDefault ?? false}
            className={`settings-switch${settings?.expandFileEditsByDefault ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void update({ expandFileEditsByDefault: !(settings?.expandFileEditsByDefault ?? false) }) }} />
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="session-sort">会话排序</label><p>会话库和顶部标签的排列方式。</p></div>
          <select id="session-sort" className="settings-wide-select" value={settings?.sessionSort ?? 'updated'} disabled={!settings || busy}
            onChange={(event) => { void update({ sessionSort: event.target.value as ConversationSettings['sessionSort'] }) }}>
            <option value="updated">最近更新</option>
            <option value="created">创建时间</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="title-locale">标题语言</label><p>模型润色会话标题时使用的语言。</p></div>
          <select id="title-locale" className="settings-wide-select" value={settings?.titleLocale ?? 'auto'} disabled={!settings || busy}
            onChange={(event) => { void update({ titleLocale: event.target.value as ConversationSettings['titleLocale'] }) }}>
            <option value="auto">跟随对话</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="title-model">标题模型</label><p>润色会话标题时使用的 DeepSeek 模型。</p></div>
          <select id="title-model" className="settings-wide-select" value={settings?.titleModel ?? 'deepseek-flash'} disabled={!settings || busy}
            onChange={(event) => { void update({ titleModel: event.target.value }) }}>
            <option value="deepseek-flash">快速（Flash）</option>
            <option value="deepseek-chat">对话（Chat）</option>
          </select>
        </div>
      </section>}
      {tab === 'appearance' && <section className="settings-section" role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance">
        <div className="settings-row">
          <div className="settings-copy"><label>界面尺寸</label></div>
          <div className="settings-size-picker" role="radiogroup" aria-label="界面尺寸">
            {UI_SIZE_OPTIONS.map((option) => {
              const active = (settings?.uiSize ?? 'small') === option.id
              return <button key={option.id} type="button" role="radio" aria-checked={active}
                className={`settings-size-option${active ? ' is-active' : ''}`} disabled={!settings || busy}
                onClick={() => { void update({ uiSize: option.id }) }}>{option.label}</button>
            })}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label>人物大小</label></div>
          <div className="settings-size-picker" role="radiogroup" aria-label="人物大小">
            {AVATAR_SIZE_OPTIONS.map((option) => {
              const active = (settings?.avatarSize ?? 'small') === option.id
              return <button key={option.id} type="button" role="radio" aria-checked={active}
                className={`settings-size-option${active ? ' is-active' : ''}`} disabled={!settings || busy}
                onClick={() => { void update({ avatarSize: option.id }) }}>{option.label}</button>
            })}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label>面板位置</label><p>聊天面板贴在人物的哪一侧，默认上方。左/右时面板与人物并排，不再随人物在屏幕上下半自动翻转。</p></div>
          <div className="settings-size-picker" role="radiogroup" aria-label="面板位置">
            {([['top', '上方'], ['bottom', '下方'], ['left', '左侧'], ['right', '右侧']] as const).map(([value, label]) => {
              const active = (settings?.panelPlacement ?? 'top') === value
              return <button key={value} type="button" role="radio" aria-checked={active}
                className={`settings-size-option${active ? ' is-active' : ''}`} disabled={!settings || busy}
                onClick={() => { void update({ panelPlacement: value }) }}>{label}</button>
            })}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label>主题</label><p>只作用于聊天面板；完成、进行、失败、等待、空闲这几个状态色两套主题共用，不跟着变。</p></div>
          <div className="settings-size-picker" role="radiogroup" aria-label="面板主题">
            {([['dark', '深色'], ['light', '浅色']] as const).map(([value, label]) => {
              const active = (settings?.panelTheme ?? 'dark') === value
              return <button key={value} type="button" role="radio" aria-checked={active}
                className={`settings-size-option${active ? ' is-active' : ''}`} disabled={!settings || busy}
                onClick={() => { void update({ panelTheme: value }) }}>{label}</button>
            })}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="avatar-renderer">人物渲染</label><p>Live2D 技术预览（Arch Chan）仅用于验证 Cubism 渲染链路，不是小鲸最终形象；可随时切回标准插画。</p></div>
          <select id="avatar-renderer" className="settings-wide-select" value={settings?.avatarRenderer ?? 'sprite'} disabled={!settings || busy}
            onChange={(event) => { void update({ avatarRenderer: event.target.value === 'live2d-preview' ? 'live2d-preview' : 'sprite' }) }}>
            <option value="sprite">标准插画</option>
            <option value="live2d-preview">Live2D 技术预览（Arch Chan）</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="tool-row-detail">工具行信息</label><p>工具名后面显示多少内容：完整带参数和改动行数，简略只留很短的一截，仅名称只显示工具名。展开后的完整输入与输出不受影响。</p></div>
          <select id="tool-row-detail" className="settings-wide-select" value={settings?.toolRowDetail ?? 'brief'} disabled={!settings || busy}
            onChange={(event) => { void update({ toolRowDetail: event.target.value as NonNullable<ConversationSettings['toolRowDetail']> }) }}>
            <option value="full">完整</option>
            <option value="brief">简略</option>
            <option value="name">仅名称</option>
          </select>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label>图片输入</label><p>当前模型是否支持直接看图。不支持时图片按文件引用发送，模型用读图工具打开。</p></div>
          <span className="settings-capability">{capabilities ? (capabilities.imageInput ? '支持' : '不支持') : '还没握手'}</span>
        </div>
      </section>}
      {tab === 'libraries' && <section className="settings-section settings-library-section" role="tabpanel" id="settings-panel-libraries" aria-labelledby="settings-tab-libraries">
        <div className="settings-library-kinds" role="tablist" aria-label="库">
          {LIBRARY_KINDS.map((kind) => {
            const count = libraries.items.filter((item) => item.kind === kind).length
            return <button key={kind} type="button" role="tab" aria-selected={libraryKind === kind}
              aria-label={LIBRARY_LABELS[kind]}
              className={`settings-library-kind${libraryKind === kind ? ' is-active' : ''}`}
              onClick={() => { setLibraryKind(kind); setMarketQuery(''); setMarketError('') }}>
              <span>{LIBRARY_LABELS[kind]}</span><small>{count}</small>
            </button>
          })}
        </div>
        <div className="settings-library-pane">
          <div className="settings-library-heading">
            <h2>{LIBRARY_LABELS[libraryKind]}库</h2>
            <p>应用安装的条目用 @ 添加；本地已有的条目由 Claude 配置直接加载。</p>
          </div>
          {libraryKind === 'skill' && <div className="settings-skill-sources" aria-label="技能市场来源">
            <span>技能市场来源</span>
            {SKILL_MARKET_SOURCES.map((source) => {
              const enabled = (settings?.skillMarketSources ?? DEFAULT_SKILL_MARKET_SOURCES).includes(source.id)
              return <button key={source.id} type="button" role="switch" aria-checked={enabled}
                className={`settings-skill-source${enabled ? ' is-on' : ''}`}
                title={source.description}
                disabled={!settings || busy}
                onClick={() => toggleSkillSource(source.id, !enabled)}>
                {source.name}
              </button>
            })}
          </div>}
          {installedLibraries.length === 0
            ? <p className="settings-library-empty">还没有添加{LIBRARY_LABELS[libraryKind]}。到下面的{LIBRARY_MARKET_LABELS[libraryKind]}找一个。</p>
            : <div className="settings-library-list">
                {installedLibraries.map((item) => (
                  <div className="settings-library-item" key={item.id}>
                    <div className="settings-library-copy">
                      <label>{item.name}{item.version && <span className="settings-library-version">v{item.version}</span>}{item.external && <span className="settings-library-version">本地已有</span>}{item.disabled && <span className="settings-library-version">已停用</span>}</label>
                      {item.description && <p>{item.description}</p>}
                      {item.license && <small>许可证：{item.license}</small>}
                      {libraryHealth[item.id] && <small className={libraryHealth[item.id].ok ? 'settings-library-health is-ok' : 'settings-library-health is-error'} role="status">{libraryHealth[item.id].message}</small>}
                    </div>
                    {item.external
                      ? <span className="settings-library-external">已在环境中</span>
                      : <div className="settings-library-actions">
                          <button type="button" disabled={libraryBusyId !== null} onClick={() => { void toggleLibraryItem(item) }}>{item.disabled ? '启用' : '停用'}</button>
                          <button type="button" disabled={libraryHealthBusyId !== null} onClick={() => { void checkLibraryItem(item) }}>{libraryHealthBusyId === item.id ? '检测中…' : '检测'}</button>
                          <button type="button" disabled={libraryBusyId !== null} onClick={() => { void removeLibraryItem(item) }}>
                            {libraryBusyId === item.id ? '移除中…' : '移除'}
                          </button>
                        </div>}
                  </div>
                ))}
              </div>}
          <div className="settings-library-market">
            <div className="settings-library-market-head">
              <h2>{LIBRARY_MARKET_LABELS[libraryKind]}</h2>
              <form onSubmit={(event) => { event.preventDefault(); void searchLibraryMarket() }}>
                <input type="text" value={marketQuery} placeholder={`搜索${LIBRARY_LABELS[libraryKind]}`}
                  aria-label={`搜索${LIBRARY_MARKET_LABELS[libraryKind]}`} disabled={marketBusy}
                  onChange={(event) => setMarketQuery(event.target.value)} />
                <button type="submit" disabled={marketBusy}>{marketBusy ? '查询中…' : '搜索'}</button>
              </form>
            </div>
            {marketError && <p className="settings-library-error" role="alert">{marketError}</p>}
            {marketBusy && marketItems.length === 0 && <p className="settings-library-empty">正在连接{LIBRARY_MARKET_LABELS[libraryKind]}…</p>}
            {!marketBusy && !marketError && marketItems.length === 0 && marketLoadedFor === libraryKind &&
              <p className="settings-library-empty">没有匹配的条目。</p>}
            <div className="settings-library-list">
              {marketItems.map((item) => {
                const installed = libraries.items.some((entry) => entry.id === item.id)
                return <div className="settings-library-item" key={item.id}>
                  <div className="settings-library-copy">
                    <label>{item.name}{item.version && <span className="settings-library-version">v{item.version}</span>}</label>
                    {item.description && <p>{item.description}</p>}
                    <small>许可证：{item.license || '以来源仓库为准'}</small>
                  </div>
                  <button type="button" disabled={installed || libraryBusyId !== null} onClick={() => { void installLibraryItem(item) }}>
                    {installed ? '已添加' : libraryBusyId === item.id ? '添加中…' : '添加'}
                  </button>
                </div>
              })}
            </div>
          </div>
        </div>
      </section>}
      {tab === 'models' && <section className="settings-section" role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models">
        {(settings?.modelProfiles ?? []).map((profile) => (
          <div className="settings-row" key={profile.id}>
            <div className="settings-copy">
              <label>{profile.name}{profile.id === settings?.activeModelProfileId && <span className="settings-model-active">使用中</span>}{profile.enabled === false && <span className="settings-model-disabled">已停用</span>}</label>
              <p>{profile.baseUrl}</p>
              {profile.needsKeyReentry && <p role="alert">密钥无法在这台电脑解密，请重新输入。</p>}
            </div>
            <div className="settings-model-actions">
              {profileDeleteId === profile.id ? <>
                <button type="button" className="settings-model-danger" disabled={busy} onClick={() => { void deleteModel(profile.id) }}>确认删除</button>
                <button type="button" disabled={busy} onClick={() => setProfileDeleteId(null)}>取消</button>
              </> : <>
                <button type="button" disabled={busy || (profile.enabled !== false && profile.id === settings?.activeModelProfileId)}
                  title={profile.id === settings?.activeModelProfileId ? '正在使用的模型不能停用' : undefined}
                  onClick={() => { void toggleModelProfile(profile) }}>{profile.enabled === false ? '启用' : '停用'}</button>
                <button type="button" disabled={busy} onClick={() => openEditModel(profile)}>编辑</button>
                <button type="button" disabled={busy} onClick={() => { setProfileDeleteId(profile.id); setModelForm(null) }}>删除</button>
              </>}
            </div>
          </div>))}
        {!modelForm && <div className="settings-row">
          <div className="settings-copy"><label>添加模型</label><p>选择厂商和标准模型，填入该厂商的 API Key。</p></div>
          <div className="settings-model-actions"><button type="button" disabled={busy || !settings} onClick={openAddModel}>添加</button></div>
        </div>}
        {modelForm && <div className="settings-model-form">
          <label>厂商
            <select value={modelForm.providerId} disabled={busy} onChange={(event) => pickModelProvider(event.target.value)}>
              {PROVIDER_CATALOG.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              <option value="custom">自定义…</option>
            </select>
          </label>
          {modelForm.providerId === 'custom'
            ? <label>端点<input type="text" value={modelForm.baseUrl} spellCheck={false} placeholder="https://…/anthropic" disabled={busy} onChange={(event) => setModelForm({ ...modelForm, baseUrl: event.target.value })} /></label>
            : <label>模型
                <select value={modelForm.modelId} disabled={busy} onChange={(event) => { if (modelForm) setModelForm({ ...modelForm, modelId: event.target.value }) }}>
                  {PROVIDER_CATALOG.find((item) => item.id === modelForm.providerId)?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>}
          {modelForm.providerId === 'custom' && <label>模型 ID<input type="text" value={modelForm.modelId} spellCheck={false} placeholder="厂商文档中的模型 ID" disabled={busy} onChange={(event) => setModelForm({ ...modelForm, modelId: event.target.value })} /></label>}
          <label>API Key<input type="password" value={modelForm.apiKey} placeholder={settings?.modelProfiles.find((profile) => profile.id === modelForm.id)?.apiKeyConfigured ? '已保存，留空保持原密钥' : '粘贴该厂商的 API Key'} disabled={busy} onChange={(event) => setModelForm({ ...modelForm, apiKey: event.target.value })} /></label>
          <label>显示名称<input type="text" maxLength={24} value={modelForm.name} disabled={busy} onChange={(event) => setModelForm({ ...modelForm, name: event.target.value })} /></label>
          <button type="button" className="settings-model-advanced" aria-expanded={modelForm.advanced} onClick={() => setModelForm({ ...modelForm, advanced: !modelForm.advanced })}>{modelForm.advanced ? '▾' : '▸'} 高级</button>
          {modelForm.advanced && <>
            <label>小模型<input type="text" value={modelForm.smallModel} spellCheck={false} placeholder="后台任务用，可留空" disabled={busy} onChange={(event) => setModelForm({ ...modelForm, smallModel: event.target.value })} /></label>
            <label>环境变量<textarea rows={3} value={modelForm.extraEnv} spellCheck={false} placeholder={settings?.modelProfiles.find((profile) => profile.id === modelForm.id)?.extraEnvConfigured ? '已保存，留空保持原配置' : 'KEY=VALUE，每行一条'} disabled={busy} onChange={(event) => setModelForm({ ...modelForm, extraEnv: event.target.value, removeExtraEnv: false })} /></label>
            {settings?.modelProfiles.find((profile) => profile.id === modelForm.id)?.extraEnvConfigured && <button type="button" disabled={busy} onClick={() => setModelForm({ ...modelForm, extraEnv: '', removeExtraEnv: true })}>{modelForm.removeExtraEnv ? '保存时将清除环境变量' : '清除已保存的环境变量'}</button>}
          </>}
          <div className="settings-model-discover-row">
            <button type="button" disabled={busy || modelDiscovering} onClick={() => { void discoverModels() }}>{modelDiscovering ? '拉取中…' : '发现模型'}</button>
            <input type="search" aria-label="搜索已发现的模型" placeholder="搜索模型 ID" value={modelForm.modelSearch}
              disabled={!modelForm.discovered.length}
              onChange={(event) => setModelForm({ ...modelForm, modelSearch: event.target.value })} />
          </div>
          {modelForm.discovered.length > 0 && <div className="settings-model-discovered" aria-label="已发现的模型">
            {modelForm.discovered
              .filter((id) => id.toLowerCase().includes(modelForm.modelSearch.trim().toLowerCase()))
              .slice(0, 24)
              .map((id) => <button key={id} type="button" className={id === modelForm.modelId ? 'is-active' : ''}
                onClick={() => setModelForm({ ...modelForm, modelId: id })}>{id}</button>)}
          </div>}
          {modelDiscoverMessage && <div className="settings-model-discover-message" role="status">{modelDiscoverMessage}</div>}
          {modelTest && <div className={`settings-model-test${modelTest.ok ? ' is-ok' : ' is-error'}`} role="status">{modelTest.message}</div>}
          <div className="settings-model-form-actions">
            <button type="button" disabled={busy} onClick={() => setModelForm(null)}>取消</button>
            <button type="button" disabled={busy || modelTesting || !draftModel()} onClick={() => { void probeModel() }}>{modelTesting ? '测试中…' : '测试连接'}</button>
            <button type="button" className="settings-model-save" disabled={busy || !draftModel()} onClick={() => { void saveModel() }}>保存</button>
          </div>
        </div>}
      </section>}
      {tab === 'voice' && <SettingsVoiceSection api={window.whaleSettings} />}
      {tab === 'memory' && <section className="settings-section" role="tabpanel" id="settings-panel-memory" aria-labelledby="settings-tab-memory">
        <div className="settings-row">
          <div className="settings-copy"><label id="memory-switch-label">长期记忆</label><p>从完成的对话提取少量稳定事实；关闭后保留现有条目，但不会用于新对话。</p></div>
          <button type="button" role="switch" aria-labelledby="memory-switch-label" aria-checked={settings?.memoryEnabled ?? true}
            className={`settings-switch${settings?.memoryEnabled ?? true ? ' is-on' : ''}`} disabled={!settings || busy}
            onClick={() => { void setMemoryEnabled(!(settings?.memoryEnabled ?? true)) }} />
        </div>
        <div className="settings-list-header"><span>已保存的事实</span><span>{memoryItems.length} 条</span></div>
        {memoryLoading && <p className="settings-empty" role="status">正在读取…</p>}
        {!memoryLoading && memoryItems.length === 0 && <p className="settings-empty">还没有长期记忆。完成对话后，小鲸会只保存明确而稳定的事实。</p>}
        {memoryItems.map((item) => <article className="settings-memory-item" key={item.id}>
          {memoryEditId === item.id ? <>
            <textarea aria-label="编辑记忆" maxLength={180} rows={3} value={memoryDraft} disabled={Boolean(memoryBusyId)} onChange={(event) => setMemoryDraft(event.target.value)} />
            <div className="settings-inline-actions">
              <button type="button" disabled={Boolean(memoryBusyId) || !memoryDraft.trim()} onClick={() => { void saveMemory() }}>保存</button>
              <button type="button" disabled={Boolean(memoryBusyId)} onClick={() => setMemoryEditId(null)}>取消</button>
            </div>
          </> : <>
            <p>{item.text}</p>
            <div className="settings-memory-meta"><span>来源会话 <code title={item.sourceConversationId}>{item.sourceConversationId.slice(0, 8)}</code></span><time dateTime={item.sourceAt}>{dateLabel(item.sourceAt)}</time></div>
            <div className="settings-inline-actions">
              <button type="button" disabled={Boolean(memoryBusyId)} onClick={() => { setMemoryEditId(item.id); setMemoryDraft(item.text) }}>编辑</button>
              <button type="button" className="is-danger" disabled={Boolean(memoryBusyId)} onClick={() => { void deleteMemory(item.id) }}>删除</button>
            </div>
          </>}
        </article>)}
      </section>}
      {tab === 'growth' && <section className="settings-section settings-growth-section" role="tabpanel" id="settings-panel-growth" aria-labelledby="settings-tab-growth">
        <div className="settings-growth-intro">
          <strong>先提出，再实验，最后由你采纳。</strong>
          <p>小鲸会根据重复失败留下改进建议。实验改动和检查结果在此审阅；GitHub 发布是独立操作。</p>
          {growth && !growth.available && <p className="settings-growth-unavailable" role="status">{growth.reason ?? '本机源码实验当前不可用。'}便携版仍可正常聊天和使用记忆。</p>}
        </div>
        <div className="settings-growth-list-head">
          <span>改进建议 {growth ? `(${growth.proposals.filter((item) => item.status !== 'discarded').length})` : ''}</span>
          <button type="button" aria-expanded={growthFormOpen} onClick={() => setGrowthFormOpen(!growthFormOpen)}>{growthFormOpen ? '收起' : '记录建议'}</button>
        </div>
        {growthFormOpen && <form className="settings-growth-form" onSubmit={(event) => { event.preventDefault(); void proposeGrowth() }}>
          <label>标题<input maxLength={80} value={growthTitle} disabled={Boolean(growthBusyId)} onChange={(event) => setGrowthTitle(event.target.value)} placeholder="简短说明要改进什么" /></label>
          <label>目标<textarea maxLength={2000} rows={2} value={growthObjective} disabled={Boolean(growthBusyId)} onChange={(event) => setGrowthObjective(event.target.value)} placeholder="具体希望小鲸做到什么" /></label>
          <label>依据<textarea maxLength={2000} rows={2} value={growthEvidence} disabled={Boolean(growthBusyId)} onChange={(event) => setGrowthEvidence(event.target.value)} placeholder="出现了什么可复现的问题" /></label>
          <button type="submit" disabled={Boolean(growthBusyId) || !growthTitle.trim() || !growthObjective.trim() || !growthEvidence.trim()}>保存建议</button>
        </form>}
        {!growth && <p className="settings-empty" role="status">正在读取建议…</p>}
        {growth?.proposals.filter((item) => item.status !== 'discarded').length === 0 && <p className="settings-empty">暂时没有改进建议。小鲸发现有依据的重复失败后会记录在这里。</p>}
        {(growth?.proposals ?? []).filter((item) => item.status !== 'discarded').length > 0 && <div className="settings-growth-layout">
          <div className="settings-growth-proposals" aria-label="改进建议列表">
            {growth?.proposals.filter((item) => item.status !== 'discarded').map((item) => <button key={item.id} type="button"
              className={`settings-growth-proposal${selectedGrowth?.id === item.id ? ' is-active' : ''}`}
              aria-current={selectedGrowth?.id === item.id ? 'true' : undefined}
              onClick={() => setGrowthSelectedId(item.id)}>
              <span className="settings-growth-proposal-title">{item.title}</span>
              <span className={`settings-growth-state status-${item.status}`}>{GROWTH_STATUS_LABEL[item.status]}</span>
            </button>)}
          </div>
          {selectedGrowth && <article className="settings-growth-detail">
            <div className="settings-growth-detail-heading"><h2>{selectedGrowth.title}</h2><time dateTime={selectedGrowth.createdAt}>{dateLabel(selectedGrowth.createdAt)}</time></div>
            <p className="settings-growth-detail-label">改进目标</p><p>{selectedGrowth.objective}</p>
            <p className="settings-growth-detail-label">发现依据</p><p>{selectedGrowth.evidence}</p>
            {selectedGrowth.error && <p className="settings-growth-error" role="alert">{selectedGrowth.error}</p>}
            {selectedGrowth.checks && <div className="settings-growth-checks" aria-label="宿主检查结果">
              {selectedGrowth.checks.map((check) => <details key={check.name}>
                <summary><span className={check.ok ? 'check-ok' : 'check-failed'}>{check.ok ? '✓' : '×'}</span> {check.name}</summary>
                <pre>{check.output || '没有输出'}</pre>
              </details>)}
            </div>}
            {selectedGrowth.diff && <details className="settings-growth-diff"><summary>查看源码差异</summary><pre>{selectedGrowth.diff}</pre></details>}
            {selectedGrowth.releaseNotes !== undefined && <div className="settings-growth-notes">
              <label htmlFor="growth-release-notes">版本说明草稿</label>
              <textarea id="growth-release-notes" rows={5} maxLength={8000} value={growthNotesDraft}
                disabled={selectedGrowth.status !== 'ready' || Boolean(growthBusyId)} onChange={(event) => setGrowthNotesDraft(event.target.value)} />
              {selectedGrowth.status === 'ready' && <button type="button" disabled={Boolean(growthBusyId) || !growthNotesDraft.trim() || growthNotesDraft.trim() === selectedGrowth.releaseNotes}
                onClick={() => { void growthAction(selectedGrowth.id, () => window.whaleSettings.growthUpdateNotes(selectedGrowth.id, growthNotesDraft), '版本说明已保存') }}>保存版本说明</button>}
            </div>}
            <div className="settings-growth-actions">
              {(selectedGrowth.status === 'proposed' || selectedGrowth.status === 'failed') && <button type="button" disabled={!growth?.available || Boolean(growthBusyId)}
                onClick={() => { void growthAction(selectedGrowth.id, () => window.whaleSettings.growthExperiment(selectedGrowth.id), '实验已完成，请审阅差异与检查结果') }}>
                {growthBusyId === selectedGrowth.id ? '实验中…' : '同意实验'}
              </button>}
              {selectedGrowth.status === 'ready' && <button type="button" disabled={Boolean(growthBusyId) || !selectedGrowth.checks?.every((check) => check.ok) || growthNotesDraft.trim() !== selectedGrowth.releaseNotes}
                onClick={() => { void growthAction(selectedGrowth.id, () => window.whaleSettings.growthAdopt(selectedGrowth.id), '已生成本机版本，其他会话空闲后启用') }}>采纳并安装本机版本</button>}
              {selectedGrowth.status === 'adopted' && <button type="button" disabled={Boolean(growthBusyId)}
                onClick={() => { void growthAction(selectedGrowth.id, () => window.whaleSettings.growthPublish(selectedGrowth.id), 'GitHub Release 已发布') }}>发布 GitHub</button>}
              {!['adopted', 'published', 'discarded', 'running'].includes(selectedGrowth.status) && <button type="button" className="is-danger" disabled={Boolean(growthBusyId)}
                onClick={() => { void growthAction(selectedGrowth.id, () => window.whaleSettings.growthDiscard(selectedGrowth.id), '建议已丢弃') }}>丢弃建议</button>}
            </div>
            {selectedGrowth.version && <p className="settings-growth-version">本机版本 v{selectedGrowth.version}</p>}
          </article>}
        </div>}
      </section>}
      {tab === 'identity' && <section className="settings-section" role="tabpanel" id="settings-panel-identity" aria-labelledby="settings-tab-identity">
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="user-name">你的称呼</label><p>它在对话里这样称呼你。</p></div>
          <form onSubmit={(event) => { event.preventDefault(); saveNames() }}>
            <input id="user-name" type="text" maxLength={24} value={userNameDraft} disabled={!settings || busy}
              onChange={(event) => setUserNameDraft(event.target.value)} onBlur={saveNames} />
            <button type="submit" disabled={!settings || busy || userNameDraft.trim() === settings.userName}>保存</button>
          </form>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="assistant-name">我的称呼</label><p>它自我介绍时用的名字。</p></div>
          <form onSubmit={(event) => { event.preventDefault(); saveNames() }}>
            <input id="assistant-name" type="text" maxLength={24} value={assistantNameDraft} disabled={!settings || busy}
              onChange={(event) => setAssistantNameDraft(event.target.value)} onBlur={saveNames} />
            <button type="submit" disabled={!settings || busy || assistantNameDraft.trim() === settings.assistantName}>保存</button>
          </form>
        </div>
      </section>}
      {tab === 'avatar' && <section className="settings-section" role="tabpanel" id="settings-panel-avatar" aria-labelledby="settings-tab-avatar">
        <div className="settings-copy"><label>人设预设</label><p>切换时同时更新人设文字、对话头像和桌面形象。</p></div>
        <div className="settings-personas" role="radiogroup" aria-label="人设预设">
          {PERSONA_PRESETS.map((preset) => {
            const active = (settings?.personaId ?? 'xiaojing') === preset.id
            const avatar = personaAvatarUrl(preset.id) ?? (preset.id === 'xiaojing' ? avatars.assistant : null)
            return <button key={preset.id} type="button" role="radio" aria-checked={active}
              className={`settings-persona${active ? ' is-active' : ''}`} disabled={!settings || busy}
              onClick={() => { setAvatars((current) => ({ ...current, assistant: null })); void update({ personaId: preset.id, assistantAvatar: null }); }}>
              <span className="settings-persona-avatar">{avatar ? <img src={avatar} alt="" /> : <span>鲸</span>}</span>
              <span className="settings-persona-name">{preset.name}</span>
              <span className="settings-persona-trait">{preset.trait}</span>
              <small>{preset.tagline}</small>
            </button>
          })}
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="user-avatar">你的头像</label><p>消息左侧的小头像。PNG 或 JPEG，小于 2 MB。</p></div>
          <label className="settings-avatar">
            {avatars.user ? <img src={avatars.user} alt="" /> : <span>你</span>}
            <input id="user-avatar" type="file" accept="image/png,image/jpeg" hidden disabled={busy}
              onChange={(event) => { void pickAvatar('user', event.target.files?.[0]); event.target.value = '' }} />
          </label>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="assistant-avatar">对话头像</label><p>上传后覆盖当前预设的头像。PNG 或 JPEG，小于 2 MB。</p></div>
          <label className="settings-avatar">
            {avatars.assistant ? <img src={avatars.assistant} alt="" /> : <span>鲸</span>}
            <input id="assistant-avatar" type="file" accept="image/png,image/jpeg" hidden disabled={busy}
              onChange={(event) => { void pickAvatar('assistant', event.target.files?.[0]); event.target.value = '' }} />
          </label>
        </div>
      </section>}
    </main>
    <div className="settings-quit">
      {quitAction
        ? <div className="settings-quit-confirm" role="alertdialog" aria-label={quitAction === 'restart' ? '确认重启小鲸' : '确认退出小鲸'}>
            <p>{quitAction === 'restart' ? '重启后对话会保存，小鲸会重新打开。' : '退出后对话会保存，下次启动继续。'}</p>
            <div className="settings-quit-actions">
              <button type="button" onClick={() => setQuitAction(null)}>取消</button>
              <button type="button" className="is-danger" onClick={() => {
                if (quitAction === 'restart') {
                  void window.whaleSettings.restart().then((waiting) => {
                    if (waiting) setNotice({ text: '当前任务结束后会自动重启。', error: false })
                    else setNotice({ text: '已取消重启，等你的新消息。', error: false })
                  })
                } else {
                  void window.whaleSettings.quit()
                }
              }}>{quitAction === 'restart' ? '确认重启' : '确认退出'}</button>
            </div>
          </div>
        : <div className="settings-quit-actions-row">
            <button type="button" className="settings-quit-button" onClick={() => setQuitAction('restart')}>重启小鲸</button>
            <button type="button" className="settings-quit-button" onClick={() => setQuitAction('quit')}>退出小鲸</button>
          </div>}
    </div>
    <div className={`settings-notice${notice?.error ? ' is-error' : ''}`} role={notice?.error ? 'alert' : 'status'}>{notice?.text}</div>
  </div>
}

if (typeof document !== 'undefined') {
  const mount = document.getElementById('root')
  if (mount) createRoot(mount).render(<SettingsPage />)
}
