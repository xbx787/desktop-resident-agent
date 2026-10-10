import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { ConversationSettings, ModelProfile } from '../shared/contracts'
import { PROVIDER_CATALOG } from '../shared/provider-catalog'
import type { SettingsAPI } from '../preload/settings'
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
  advanced: boolean
}

const SETTINGS_TABS = [
  { id: 'conversation', label: '对话' },
  { id: 'models', label: '模型' },
  { id: 'identity', label: '称呼' },
  { id: 'avatar', label: '头像' }
] as const
type SettingsTab = typeof SETTINGS_TABS[number]['id']

export function SettingsPage() {
  const [settings, setSettings] = useState<ConversationSettings | null>(null)
  const [tabsDraft, setTabsDraft] = useState('5')
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

  async function update(patch: Partial<ConversationSettings>): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const current = await window.whaleSettings.update(patch)
      setSettings(current)
      setTabsDraft(String(current.visibleConversationTabs))
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
      baseUrl: provider.baseUrl, apiKey: '', smallModel: provider.smallModel ?? '', extraEnv: '', advanced: false })
  }

  function openEditModel(profile: ModelProfile): void {
    const provider = PROVIDER_CATALOG.find((item) => item.baseUrl === profile.baseUrl && item.models.some((model) => model.id === profile.model))
    setModelTest(null)
    setProfileDeleteId(null)
    setModelForm({ id: profile.id, providerId: provider?.id ?? 'custom', modelId: profile.model, name: profile.name,
      baseUrl: profile.baseUrl, apiKey: profile.apiKey, smallModel: profile.smallModel ?? '', extraEnv: profile.extraEnv ?? '', advanced: Boolean(profile.extraEnv) })
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
    if (!name || !baseUrl || !apiKey || !model) return null
    return {
      id: modelForm.id ?? crypto.randomUUID(),
      name, baseUrl, apiKey, model,
      ...(modelForm.smallModel.trim() ? { smallModel: modelForm.smallModel.trim() } : {}),
      ...(modelForm.extraEnv.trim() ? { extraEnv: modelForm.extraEnv } : {})
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
      {tab === 'models' && <section className="settings-section" role="tabpanel" id="settings-panel-models" aria-labelledby="settings-tab-models">
        {(settings?.modelProfiles ?? []).map((profile) => (
          <div className="settings-row" key={profile.id}>
            <div className="settings-copy">
              <label>{profile.name}{profile.id === settings?.activeModelProfileId && <span className="settings-model-active">使用中</span>}</label>
              <p>{profile.baseUrl}</p>
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
          <label>API Key<input type="password" value={modelForm.apiKey} placeholder="粘贴该厂商的 API Key" disabled={busy} onChange={(event) => setModelForm({ ...modelForm, apiKey: event.target.value })} /></label>
          <label>显示名称<input type="text" maxLength={24} value={modelForm.name} disabled={busy} onChange={(event) => setModelForm({ ...modelForm, name: event.target.value })} /></label>
          <button type="button" className="settings-model-advanced" aria-expanded={modelForm.advanced} onClick={() => setModelForm({ ...modelForm, advanced: !modelForm.advanced })}>{modelForm.advanced ? '▾' : '▸'} 高级</button>
          {modelForm.advanced && <>
            <label>小模型<input type="text" value={modelForm.smallModel} spellCheck={false} placeholder="后台任务用，可留空" disabled={busy} onChange={(event) => setModelForm({ ...modelForm, smallModel: event.target.value })} /></label>
            <label>环境变量<textarea rows={3} value={modelForm.extraEnv} spellCheck={false} placeholder={'KEY=VALUE，每行一条'} disabled={busy} onChange={(event) => setModelForm({ ...modelForm, extraEnv: event.target.value })} /></label>
          </>}
          {modelTest && <div className={`settings-model-test${modelTest.ok ? ' is-ok' : ' is-error'}`} role="status">{modelTest.message}</div>}
          <div className="settings-model-form-actions">
            <button type="button" disabled={busy} onClick={() => setModelForm(null)}>取消</button>
            <button type="button" disabled={busy || modelTesting || !draftModel()} onClick={() => { void probeModel() }}>{modelTesting ? '测试中…' : '测试连接'}</button>
            <button type="button" className="settings-model-save" disabled={busy || !draftModel()} onClick={() => { void saveModel() }}>保存</button>
          </div>
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
