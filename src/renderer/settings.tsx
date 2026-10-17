import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSettings, GrowthProposal, ModelProfile } from '../shared/contracts'
import { PROVIDER_CATALOG } from '../shared/provider-catalog'
import type { GrowthOverview, SettingsAPI } from '../preload/settings'
import type { MemoryItem } from '../main/memory-service'
import './settings.css'

declare global {
  interface Window {
    whaleSettings: SettingsAPI
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
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
}

const SETTINGS_TABS = [
  { id: 'conversation', label: '对话' },
  { id: 'appearance', label: '外观' },
  { id: 'models', label: '模型' },
  { id: 'memory', label: '记忆' },
  { id: 'growth', label: '成长' },
  { id: 'identity', label: '称呼' },
  { id: 'avatar', label: '头像' }
] as const
type SettingsTab = typeof SETTINGS_TABS[number]['id']

/** 界面尺寸档：小是原来的样子，中、大各上调一档。 */
const UI_SIZE_OPTIONS: ReadonlyArray<{ id: ConversationSettings['uiSize']; label: string }> = [
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
  const [busy, setBusy] = useState(false)
  const [version, setVersion] = useState('')
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [userNameDraft, setUserNameDraft] = useState('')
  const [assistantNameDraft, setAssistantNameDraft] = useState('')
  const [avatars, setAvatars] = useState<{ user: string | null; assistant: string | null }>({ user: null, assistant: null })
  const [modelForm, setModelForm] = useState<ModelFormState | null>(null)
  const [modelTest, setModelTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [modelTesting, setModelTesting] = useState(false)
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

  useEffect(() => {
    let active = true
    void window.whaleSettings.version().then((current) => {
      if (active) setVersion(current)
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
    }).catch((cause: unknown) => {
      if (active) setNotice({ text: errorMessage(cause), error: true })
    })
    void Promise.all([window.whaleSettings.readAvatar('user'), window.whaleSettings.readAvatar('assistant')])
      .then(([user, assistant]) => { if (active) setAvatars({ user, assistant }) })
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
    if (tab !== 'growth') return
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

  const selectedGrowth = growth?.proposals.find((item) => item.id === growthSelectedId && item.status !== 'discarded') ?? growth?.proposals.find((item) => item.status !== 'discarded') ?? null
  useEffect(() => {
    setGrowthNotesDraft(selectedGrowth?.releaseNotes ?? '')
  }, [selectedGrowth?.id, selectedGrowth?.releaseNotes])

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

  function saveGoalBudget(): void {
    const goalMaxIterations = Number(goalIterationsDraft)
    const goalMaxMinutes = Number(goalMinutesDraft)
    if (!Number.isInteger(goalMaxIterations) || goalMaxIterations < 1 || goalMaxIterations > 300 ||
      !Number.isInteger(goalMaxMinutes) || goalMaxMinutes < 1 || goalMaxMinutes > 1440) {
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
    setProfileDeleteId(null)
    setModelForm({ id: null, providerId: provider.id, modelId: provider.models[0].id, name: provider.name,
      baseUrl: provider.baseUrl, apiKey: '', smallModel: provider.smallModel ?? '', extraEnv: '', removeExtraEnv: false, advanced: false })
  }

  function openEditModel(profile: ModelProfile): void {
    const provider = PROVIDER_CATALOG.find((item) => item.baseUrl === profile.baseUrl && item.models.some((model) => model.id === profile.model))
    setModelTest(null)
    setProfileDeleteId(null)
    setModelForm({ id: profile.id, providerId: provider?.id ?? 'custom', modelId: profile.model, name: profile.name,
      baseUrl: profile.baseUrl, apiKey: '', smallModel: profile.smallModel ?? '', extraEnv: '', removeExtraEnv: false, advanced: Boolean(profile.extraEnvConfigured) })
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
        <div className="settings-row settings-budget-row">
          <div className="settings-copy"><label id="goal-budget-label">目标模式上限</label><p>达到轮数或时长上限即停止目标，待发送消息会保留。</p></div>
          <form aria-labelledby="goal-budget-label" onSubmit={(event) => { event.preventDefault(); saveGoalBudget() }}>
            <label htmlFor="goal-iterations">轮数<input id="goal-iterations" type="number" min="1" max="300" step="1" value={goalIterationsDraft} disabled={!settings || busy} onChange={(event) => setGoalIterationsDraft(event.target.value)} /></label>
            <label htmlFor="goal-minutes">分钟<input id="goal-minutes" type="number" min="1" max="1440" step="1" value={goalMinutesDraft} disabled={!settings || busy} onChange={(event) => setGoalMinutesDraft(event.target.value)} /></label>
            <button type="submit" disabled={!settings || busy || (goalIterationsDraft === String(settings.goalMaxIterations) && goalMinutesDraft === String(settings.goalMaxMinutes))}>应用</button>
          </form>
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
      </section>}
      {tab === 'appearance' && <section className="settings-section" role="tabpanel" id="settings-panel-appearance" aria-labelledby="settings-tab-appearance">
        <div className="settings-row">
          <div className="settings-copy"><label>界面尺寸</label><p>小是现在的样子；中、大逐级把整套字号放大。改完立刻生效，所有窗口一起变。</p></div>
          <div className="settings-size-picker" role="radiogroup" aria-label="界面尺寸">
            {UI_SIZE_OPTIONS.map((option) => {
              const active = (settings?.uiSize ?? 'small') === option.id
              return <button key={option.id} type="button" role="radio" aria-checked={active}
                className={`settings-size-option${active ? ' is-active' : ''}`} disabled={!settings || busy}
                onClick={() => { void update({ uiSize: option.id }) }}>{option.label}</button>
            })}
          </div>
        </div>
      </section>}
      {tab === 'models' && <section className="settings-section" role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models">
        {(settings?.modelProfiles ?? []).map((profile) => (
          <div className="settings-row" key={profile.id}>
            <div className="settings-copy">
              <label>{profile.name}{profile.id === settings?.activeModelProfileId && <span className="settings-model-active">使用中</span>}</label>
              <p>{profile.baseUrl}</p>
              {profile.needsKeyReentry && <p role="alert">密钥无法在这台电脑解密，请重新输入。</p>}
            </div>
            <div className="settings-model-actions">
              {profileDeleteId === profile.id ? <>
                <button type="button" className="settings-model-danger" disabled={busy} onClick={() => { void deleteModel(profile.id) }}>确认删除</button>
                <button type="button" disabled={busy} onClick={() => setProfileDeleteId(null)}>取消</button>
              </> : <>
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
          {modelTest && <div className={`settings-model-test${modelTest.ok ? ' is-ok' : ' is-error'}`} role="status">{modelTest.message}</div>}
          <div className="settings-model-form-actions">
            <button type="button" disabled={busy} onClick={() => setModelForm(null)}>取消</button>
            <button type="button" disabled={busy || modelTesting || !draftModel()} onClick={() => { void probeModel() }}>{modelTesting ? '测试中…' : '测试连接'}</button>
            <button type="button" className="settings-model-save" disabled={busy || !draftModel()} onClick={() => { void saveModel() }}>保存</button>
          </div>
        </div>}
      </section>}
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
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="user-avatar">你的头像</label><p>消息左侧的小头像。PNG 或 JPEG，小于 2 MB。</p></div>
          <label className="settings-avatar">
            {avatars.user ? <img src={avatars.user} alt="" /> : <span>你</span>}
            <input id="user-avatar" type="file" accept="image/png,image/jpeg" hidden disabled={busy}
              onChange={(event) => { void pickAvatar('user', event.target.files?.[0]); event.target.value = '' }} />
          </label>
        </div>
        <div className="settings-row">
          <div className="settings-copy"><label htmlFor="assistant-avatar">小鲸头像</label><p>消息左侧的小头像。PNG 或 JPEG，小于 2 MB。</p></div>
          <label className="settings-avatar">
            {avatars.assistant ? <img src={avatars.assistant} alt="" /> : <span>鲸</span>}
            <input id="assistant-avatar" type="file" accept="image/png,image/jpeg" hidden disabled={busy}
              onChange={(event) => { void pickAvatar('assistant', event.target.files?.[0]); event.target.value = '' }} />
          </label>
        </div>
      </section>}
    </main>
    <div className={`settings-notice${notice?.error ? ' is-error' : ''}`} role={notice?.error ? 'alert' : 'status'}>{notice?.text}</div>
  </div>
}

if (typeof document !== 'undefined') {
  const mount = document.getElementById('root')
  if (mount) createRoot(mount).render(<SettingsPage />)
}
