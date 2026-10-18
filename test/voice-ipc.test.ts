import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { parseSynthesizeRequest, parseTranscribeRequest, parseVoiceSettingsPatch, registerVoiceIpc } from '../src/main/voice-ipc'

const settings = {
  keyConfigured: false, envKeyAvailable: false, needsKeyReentry: false,
  protectionUnavailable: false, loadError: false, voice: 'claire', speed: 1,
  autoSpeak: true, baseUrl: 'https://api.siliconflow.com',
  sttModel: 'FunAudioLLM/SenseVoiceSmall', ttsModel: 'FunAudioLLM/CosyVoice2-0.5B'
}

function makeHarness() {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>()
  const service = {
    getVoiceConfig: vi.fn(async () => ({ siliconFlowAvailable: true })),
    transcribe: vi.fn(async () => ({ text: '你好' })),
    synthesize: vi.fn(async () => ({ audioBase64: 'AA==', mimeType: 'audio/mpeg', cached: false })),
    getPublicSettings: vi.fn(async () => settings),
    saveSettings: vi.fn(async () => settings),
    testConnection: vi.fn(async () => ({ ok: true, message: 'ok' })),
    startDocumentJob: vi.fn(async () => ({ jobId: 'job-1', total: 2 })),
    cancelDocumentJob: vi.fn(async () => undefined),
    documentOutputPath: vi.fn(async () => 'D:\\data\\audio\\out'),
    audioRoot: 'D:\\data\\audio'
  }
  const openExternal = vi.fn(async () => undefined)
  const openPath = vi.fn(async () => undefined)
  registerVoiceIpc({
    ipcMain: { handle: (channel, handler) => { handlers.set(channel, handler as never) } } as never,
    service: service as never,
    trusted: (event) => event.sender.id === 1,
    settingsTrusted: (event) => event.sender.id === 2,
    broadcastConfig: async () => undefined,
    sendJobProgress: () => undefined,
    pickDocument: async () => null,
    openExternal,
    openPath
  })
  return { handlers, service, openExternal, openPath }
}

const avatarEvent = { sender: { id: 1 } } as unknown as IpcMainInvokeEvent
const settingsEvent = { sender: { id: 2 } } as unknown as IpcMainInvokeEvent
const strangerEvent = { sender: { id: 9 } } as unknown as IpcMainInvokeEvent

describe('voice IPC', () => {
  it('rejects the wrong window for each channel', async () => {
    const { handlers } = makeHarness()
    expect(() => handlers.get('pet:get-voice-config')!(strangerEvent)).toThrow('无效')
    expect(() => handlers.get('pet:settings:voice:get')!(avatarEvent)).toThrow('无效')
    expect(() => handlers.get('pet:get-voice-config')!(settingsEvent)).toThrow('无效')
  })

  it('validates transcribe and synthesize arguments', async () => {
    const { handlers } = makeHarness()
    expect(() => handlers.get('pet:transcribe-audio')!(avatarEvent, { bytes: [], mimeType: 'audio/webm' })).toThrow('无效')
    expect(() => handlers.get('pet:transcribe-audio')!(avatarEvent, { bytes: [1], mimeType: 'text/plain' })).toThrow('无效')
    expect(() => handlers.get('pet:voice:synthesize')!(avatarEvent, { text: '' })).toThrow('无效')
    expect(() => handlers.get('pet:voice:synthesize')!(avatarEvent, { text: 'x'.repeat(301) })).toThrow('无效')
    expect(() => handlers.get('pet:voice:synthesize')!(avatarEvent, { text: '你好', voice: 'nope' })).toThrow('无效')
    expect(parseSynthesizeRequest({ text: '你好', speed: 1.2 })).toEqual({ text: '你好', speed: 1.2 })
  })

  it('rejects a patch that both sets and clears the key', () => {
    expect(() => parseVoiceSettingsPatch({ apiKey: 'x', clearKey: true })).toThrow('无效')
    expect(parseVoiceSettingsPatch({ voice: 'anna', speed: 1.1 })).toEqual({ voice: 'anna', speed: 1.1 })
  })

  it('opens only the fixed key page from settings', async () => {
    const { handlers, openExternal } = makeHarness()
    await handlers.get('pet:settings:voice:open-key-page')!(settingsEvent)
    expect(openExternal).toHaveBeenCalledWith('https://cloud.siliconflow.com/account/ak')
  })

  it('runs a document job and opens a validated output directory', async () => {
    const { handlers, service, openPath } = makeHarness()
    const job = await handlers.get('pet:settings:voice:convert')!(settingsEvent, 'D:\\docs\\lesson.md')
    expect(job).toEqual({ jobId: 'job-1', total: 2 })
    await handlers.get('pet:settings:voice:open-output')!(settingsEvent, 'job-1')
    expect(service.documentOutputPath).toHaveBeenCalledWith('job-1')
    expect(openPath).toHaveBeenCalledWith('D:\\data\\audio\\out')
    await expect(handlers.get('pet:settings:voice:convert')!(settingsEvent, 'relative.md')).rejects.toThrow('无效')
  })
})
