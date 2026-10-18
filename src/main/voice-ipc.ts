import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import path from 'node:path'
import type { VoiceJobProgress, VoiceSettingsPatch } from '../shared/contracts'
import { isSpeechSpeed, isVoicePresetId } from '../shared/voice'
import { SILICONFLOW_KEY_PAGES } from '../shared/voice'
import type { VoiceService } from './voice-service'

export interface VoiceIpcDeps {
  ipcMain: Pick<IpcMain, 'handle'>
  service: VoiceService
  trusted: (event: IpcMainInvokeEvent) => boolean
  settingsTrusted: (event: IpcMainInvokeEvent) => boolean
  broadcastConfig: () => Promise<void>
  sendJobProgress: (progress: VoiceJobProgress) => void
  pickDocument: () => Promise<{ path: string; name: string; size: number } | null>
  openExternal: (url: string) => Promise<void>
  openPath: (target: string) => Promise<void>
}

const AUDIO_MIMES = new Set(['audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg'])
const MAX_AUDIO_BYTES = 10 * 1024 * 1024

function invalid(): never {
  throw new Error('无效的界面请求。')
}

export function parseTranscribeRequest(raw: unknown): { bytes: number[]; mimeType: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.bytes) || record.bytes.length === 0 || record.bytes.length > MAX_AUDIO_BYTES) invalid()
  if (record.bytes.some((value) => typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 255)) invalid()
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : ''
  if (!AUDIO_MIMES.has(mimeType)) invalid()
  return { bytes: record.bytes as number[], mimeType }
}

export function parseSynthesizeRequest(raw: unknown): { text: string; voice?: string; speed?: number } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const record = raw as Record<string, unknown>
  if (typeof record.text !== 'string') invalid()
  const text = record.text.trim()
  if (!text || text.length > 300) invalid()
  if (record.voice !== undefined && !isVoicePresetId(record.voice)) invalid()
  if (record.speed !== undefined && !isSpeechSpeed(record.speed)) invalid()
  return {
    text,
    ...(record.voice === undefined ? {} : { voice: record.voice as string }),
    ...(record.speed === undefined ? {} : { speed: record.speed as number })
  }
}

export function parseVoiceSettingsPatch(raw: unknown): VoiceSettingsPatch {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid()
  const record = raw as Record<string, unknown>
  const patch: VoiceSettingsPatch = {}
  if (record.apiKey !== undefined) {
    if (typeof record.apiKey !== 'string' || !record.apiKey.trim() || record.apiKey.length > 512 ||
        /[\r\n]/u.test(record.apiKey)) invalid()
    patch.apiKey = record.apiKey.trim()
  }
  if (record.clearKey !== undefined) {
    if (typeof record.clearKey !== 'boolean') invalid()
    patch.clearKey = record.clearKey
  }
  if (patch.apiKey && patch.clearKey) invalid()
  if (record.importEnvKey !== undefined) {
    if (typeof record.importEnvKey !== 'boolean') invalid()
    patch.importEnvKey = record.importEnvKey
  }
  if (record.voice !== undefined) {
    if (!isVoicePresetId(record.voice)) invalid()
    patch.voice = record.voice
  }
  if (record.speed !== undefined) {
    if (!isSpeechSpeed(record.speed)) invalid()
    patch.speed = record.speed
  }
  if (record.autoSpeak !== undefined) {
    if (typeof record.autoSpeak !== 'boolean') invalid()
    patch.autoSpeak = record.autoSpeak
  }
  if (record.baseUrl !== undefined) {
    if (typeof record.baseUrl !== 'string' || record.baseUrl.length > 200 || !/^https?:\/\//u.test(record.baseUrl)) invalid()
    patch.baseUrl = record.baseUrl
  }
  return patch
}

export function keyPageForBaseUrl(baseUrl: string): string {
  return baseUrl.includes('siliconflow.cn') ? SILICONFLOW_KEY_PAGES[0] : SILICONFLOW_KEY_PAGES[1]
}

export function registerVoiceIpc(deps: VoiceIpcDeps): void {
  const { ipcMain, service } = deps

  ipcMain.handle('pet:get-voice-config', (event) => {
    if (!deps.trusted(event)) invalid()
    return service.getVoiceConfig()
  })

  ipcMain.handle('pet:transcribe-audio', (event, raw: unknown) => {
    if (!deps.trusted(event)) invalid()
    return service.transcribe(parseTranscribeRequest(raw))
  })

  ipcMain.handle('pet:voice:synthesize', (event, raw: unknown) => {
    if (!deps.trusted(event)) invalid()
    return service.synthesize(parseSynthesizeRequest(raw))
  })

  ipcMain.handle('pet:settings:voice:get', (event) => {
    if (!deps.settingsTrusted(event)) invalid()
    return service.getPublicSettings()
  })

  ipcMain.handle('pet:settings:voice:save', async (event, raw: unknown) => {
    if (!deps.settingsTrusted(event)) invalid()
    const saved = await service.saveSettings(parseVoiceSettingsPatch(raw))
    await deps.broadcastConfig()
    return saved
  })

  ipcMain.handle('pet:settings:voice:test', async (event, raw: unknown) => {
    if (!deps.settingsTrusted(event)) invalid()
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 512)) invalid()
    if (input.voice !== undefined && !isVoicePresetId(input.voice)) invalid()
    if (input.speed !== undefined && !isSpeechSpeed(input.speed)) invalid()
    return service.testConnection({
      ...(typeof input.apiKey === 'string' && input.apiKey.trim() ? { apiKey: input.apiKey.trim() } : {}),
      ...(input.voice === undefined ? {} : { voice: input.voice as string }),
      ...(input.speed === undefined ? {} : { speed: input.speed as number })
    })
  })

  ipcMain.handle('pet:settings:voice:pick-document', (event) => {
    if (!deps.settingsTrusted(event)) invalid()
    return deps.pickDocument()
  })

  ipcMain.handle('pet:settings:voice:convert', async (event, raw: unknown) => {
    if (!deps.settingsTrusted(event)) invalid()
    if (typeof raw !== 'string' || !path.isAbsolute(raw) || !/\.(md|txt)$/iu.test(raw)) invalid()
    return service.startDocumentJob(raw)
  })

  ipcMain.handle('pet:settings:voice:cancel', async (event, raw: unknown) => {
    if (!deps.settingsTrusted(event)) invalid()
    if (typeof raw !== 'string' || raw.length > 80) invalid()
    await service.cancelDocumentJob(raw)
  })

  ipcMain.handle('pet:settings:voice:open-output', async (event, raw: unknown) => {
    if (!deps.settingsTrusted(event)) invalid()
    if (typeof raw !== 'string' || raw.length > 80) invalid()
    await deps.openPath(await service.documentOutputPath(raw))
  })

  ipcMain.handle('pet:settings:voice:open-audio-root', async (event) => {
    if (!deps.settingsTrusted(event)) invalid()
    await deps.openPath(service.audioRoot)
  })

  ipcMain.handle('pet:settings:voice:open-key-page', async (event) => {
    if (!deps.settingsTrusted(event)) invalid()
    const settings = await service.getPublicSettings()
    await deps.openExternal(keyPageForBaseUrl(settings.baseUrl))
  })
}
