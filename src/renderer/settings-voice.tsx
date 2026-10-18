import { useEffect, useState } from 'react'
import type { VoiceJobProgress, VoiceSettingsPublic } from '../shared/contracts'
import { SILICONFLOW_KEY_PAGES, VOICE_PRESETS } from '../shared/voice'
import { publicErrorText } from '../shared/error-copy'
import type { SettingsAPI } from '../preload/settings'

function errorText(cause: unknown): string {
  return publicErrorText(cause instanceof Error ? cause.message : String(cause))
}

function progressText(progress: VoiceJobProgress): string {
  if (progress.phase === 'preparing') return '正在准备文档…'
  if (progress.phase === 'synthesizing') return `正在合成 ${progress.completed}/${progress.total}`
  if (progress.phase === 'finalizing') return '正在整理音频…'
  if (progress.phase === 'done') return `已完成 ${progress.completed}/${progress.total}`
  if (progress.phase === 'cancelled') return `已取消，完成 ${progress.completed}/${progress.total}`
  return progress.message || '文档转音频失败。'
}

export function SettingsVoiceSection({ api }: { api: SettingsAPI }) {
  const [settings, setSettings] = useState<VoiceSettingsPublic | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [test, setTest] = useState<{ ok: boolean; message: string } | null>(null)
  const [document, setDocument] = useState<{ path: string; name: string; size: number } | null>(null)
  const [progress, setProgress] = useState<VoiceJobProgress | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api.voiceGet().then((current) => {
      if (active) {
        setSettings(current)
        setProgress(current.lastDocumentJob ?? null)
        if (current.lastDocumentJob && (current.lastDocumentJob.phase === 'synthesizing' || current.lastDocumentJob.phase === 'preparing')) {
          setJobId(current.lastDocumentJob.jobId)
        }
      }
    }).catch((cause: unknown) => {
      if (active) setNotice({ text: errorText(cause), error: true })
    })
    let unsubscribe: () => void = () => undefined
    try {
      unsubscribe = api.onVoiceJobProgress((next) => {
        if (!active) return
        setProgress(next)
        setJobId(next.phase === 'done' || next.phase === 'cancelled' || next.phase === 'failed' ? null : next.jobId)
      })
    } catch {
      // Preload may be absent in a static preview.
    }
    return () => { active = false; unsubscribe() }
  }, [api])

  async function save(patch: Parameters<SettingsAPI['voiceSave']>[0]): Promise<void> {
    if (busy) return
    setBusy(true)
    setNotice(null)
    try {
      const next = await api.voiceSave(patch)
      setSettings(next)
      setKeyDraft('')
      setNotice({ text: '语音设置已保存。', error: false })
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function testConnection(): Promise<void> {
    if (busy) return
    setBusy(true)
    setTest(null)
    try {
      setTest(await api.voiceTest(keyDraft.trim() ? { apiKey: keyDraft.trim() } : undefined))
    } catch (cause) {
      setTest({ ok: false, message: errorText(cause) })
    } finally {
      setBusy(false)
    }
  }

  async function pickDocument(): Promise<void> {
    if (busy) return
    try {
      const picked = await api.voicePickDocument()
      if (!picked) return
      setDocument(picked)
      setProgress(null)
      setJobId(null)
      setNotice(null)
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true })
    }
  }

  async function convert(): Promise<void> {
    if (!document || busy) return
    setBusy(true)
    setNotice(null)
    try {
      const job = await api.voiceConvert(document.path)
      setJobId(job.jobId)
      setProgress({ jobId: job.jobId, phase: 'preparing', completed: 0, total: job.total })
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true })
    } finally {
      setBusy(false)
    }
  }

  async function cancel(): Promise<void> {
    if (!jobId) return
    try {
      await api.voiceCancel(jobId)
    } catch (cause) {
      setNotice({ text: errorText(cause), error: true })
    }
  }

  const percent = progress && progress.total > 0
    ? Math.round((progress.completed / progress.total) * 100)
    : 0

  return <section className="settings-section settings-voice-section" role="tabpanel" id="settings-panel-voice" aria-labelledby="settings-tab-voice">
    <div className="settings-row">
      <div className="settings-copy">
        <label>语音服务</label>
        <p>转写和朗读使用 SiliconFlow：SenseVoice 负责听，CosyVoice2 负责说。Key 只保存在本机，并用 Windows 加密。</p>
      </div>
      <span className={`settings-voice-state${settings?.keyConfigured ? ' is-on' : ''}`}>
        {settings?.keyConfigured ? '已配置' : settings?.envKeyAvailable ? '环境变量可用' : '未配置'}
      </span>
    </div>
    {settings?.protectionUnavailable && <p className="settings-voice-warning" role="alert">Windows 密钥保护暂不可用，Key 无法保存。</p>}
    {settings?.loadError && <p className="settings-voice-warning" role="alert">语音配置损坏，已使用默认值；保存后会重建。</p>}
    <div className="settings-voice-form">
      <label>SiliconFlow API Key
        <input type="password" value={keyDraft} autoComplete="off" spellCheck={false}
          placeholder={settings?.keyConfigured ? '已保存，留空保持不变' : '粘贴 SiliconFlow API Key'}
          disabled={busy} onChange={(event) => setKeyDraft(event.target.value)} />
      </label>
      <div className="settings-voice-actions">
        <button type="button" disabled={busy} onClick={() => { void testConnection() }}>{busy ? '处理中…' : '测试连接'}</button>
        {keyDraft.trim() && <button type="button" disabled={busy} onClick={() => { void save({ apiKey: keyDraft }) }}>保存 Key</button>}
        {settings?.keyConfigured && <button type="button" disabled={busy} onClick={() => { void save({ clearKey: true }) }}>清除 Key</button>}
        {!settings?.keyConfigured && settings?.envKeyAvailable &&
          <button type="button" disabled={busy} onClick={() => { void save({ importEnvKey: true }) }}>使用环境变量中的 Key</button>}
      </div>
      {test && <p className={`settings-voice-test${test.ok ? ' is-ok' : ' is-error'}`} role="status">{test.message}</p>}
      <p className="settings-voice-hint">
        获取 Key：<span className="settings-voice-url">{SILICONFLOW_KEY_PAGES[0]}</span>
        <button type="button" onClick={() => { void api.voiceOpenKeyPage() }}>打开</button>
      </p>

      <label>朗读音色
        <select value={settings?.voice ?? 'claire'} disabled={busy || !settings}
          onChange={(event) => { void save({ voice: event.target.value }) }}>
          {VOICE_PRESETS.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}（{preset.id}）</option>)}
        </select>
      </label>
      <label>语速 <span className="settings-voice-speed">{settings?.speed.toFixed(2) ?? '1.00'}×</span>
        <input type="range" min="0.5" max="2" step="0.05" value={settings?.speed ?? 1} disabled={busy || !settings}
          onChange={(event) => { setSettings((current) => current ? { ...current, speed: Number(event.target.value) } : current) }}
          onPointerUp={(event) => { void save({ speed: Number(event.currentTarget.value) }) }}
          onKeyUp={(event) => { void save({ speed: Number(event.currentTarget.value) }) }} />
      </label>
      <button type="button" role="switch" aria-checked={settings?.autoSpeak ?? true}
        className={`settings-voice-toggle${settings?.autoSpeak ?? true ? ' is-on' : ''}`} disabled={busy || !settings}
        onClick={() => { void save({ autoSpeak: !(settings?.autoSpeak ?? true) }) }}>
        <span>回复完成后自动朗读</span><span className="settings-voice-switch" aria-hidden="true" />
      </button>
    </div>

    <div className="settings-row settings-voice-document-head">
      <div className="settings-copy">
        <label>文档转音频</label>
        <p>选择 .md 或 .txt，按段落合成到 data/audio。每段一个 mp3，附 playlist.m3u，适合通勤时顺序播放。</p>
      </div>
      <button type="button" disabled={busy} onClick={() => { void pickDocument() }}>选择文档</button>
    </div>
    {document && <div className="settings-voice-document">
      <p><strong>{document.name}</strong><span>{Math.ceil(document.size / 1024)} KB</span></p>
      <div className="settings-voice-actions">
        <button type="button" disabled={busy || Boolean(jobId)} onClick={() => { void convert() }}>{jobId ? '正在转换…' : '生成音频'}</button>
        {jobId && <button type="button" onClick={() => { void cancel() }}>取消</button>}
        {progress?.outputDir && <button type="button" onClick={() => { void api.voiceOpenOutput(progress.jobId) }}>打开输出目录</button>}
        <button type="button" onClick={() => { void api.voiceOpenAudioRoot() }}>打开音频根目录</button>
      </div>
    </div>}
    {progress && <div className="settings-voice-progress" role="status">
      <p>{progressText(progress)}</p>
      {progress.phase === 'synthesizing' && <div className="settings-voice-bar" aria-hidden="true"><i style={{ transform: `scaleX(${Math.max(0.02, percent / 100)})` }} /></div>}
    </div>}
    {notice && <p className={`settings-voice-notice${notice.error ? ' is-error' : ''}`} role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
  </section>
}
