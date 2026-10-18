import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { VoiceSettingsPatch, VoiceSettingsPublic } from '../shared/contracts'
import {
  DEFAULT_SILICONFLOW_BASE_URL, DEFAULT_SPEECH_SPEED, DEFAULT_VOICE, STT_MODEL, TTS_MODEL,
  clampSpeechSpeed, isVoicePresetId
} from '../shared/voice'
import { SecretProtectionUnavailableError, isEncryptedSecret, type SecretCodec } from './secret-storage'

interface StoredVoice {
  version: 1
  apiKey: string
  voice: string
  speed: number
  autoSpeak: boolean
  baseUrl: string
}

export interface VoiceRuntimeSettings {
  voice: string
  speed: number
  autoSpeak: boolean
  baseUrl: string
  sttModel: string
  ttsModel: string
}

function defaults(): StoredVoice {
  return {
    version: 1,
    apiKey: '',
    voice: DEFAULT_VOICE,
    speed: DEFAULT_SPEECH_SPEED,
    autoSpeak: true,
    baseUrl: DEFAULT_SILICONFLOW_BASE_URL
  }
}

function validBaseUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SILICONFLOW_BASE_URL
  const trimmed = value.trim().replace(/\/+$/u, '')
  return /^https?:\/\/[^\s]+$/u.test(trimmed) ? trimmed.slice(0, 200) : DEFAULT_SILICONFLOW_BASE_URL
}

/** data/voice.json: the API key is encrypted with the OS codec; the renderer
 *  only ever sees booleans. */
export class VoiceConfigStore {
  readonly filePath: string
  private cached: StoredVoice | null = null
  private loaded = false
  private loadError = false
  private needsKeyReentry = false
  private protectionUnavailable = false
  private writeChain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly dataRoot: string,
    private readonly codec: SecretCodec,
    private readonly env: NodeJS.ProcessEnv = process.env
  ) {
    this.filePath = path.join(dataRoot, 'voice.json')
  }

  private async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(this.filePath, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad')
      const record = parsed as Record<string, unknown>
      this.cached = {
        version: 1,
        apiKey: typeof record.apiKey === 'string' ? record.apiKey.slice(0, 4_000) : '',
        voice: isVoicePresetId(record.voice) ? record.voice : DEFAULT_VOICE,
        speed: clampSpeechSpeed(record.speed),
        autoSpeak: record.autoSpeak !== false,
        baseUrl: validBaseUrl(record.baseUrl)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.loadError = true
      this.cached = defaults()
    }
  }

  private envKey(): string {
    const value = this.env.SILICONFLOW_API_KEY
    return typeof value === 'string' ? value.trim() : ''
  }

  /** Stored key first, then the launch environment. A cross-device ciphertext
   *  is reported instead of crashing. */
  private resolveKey(): { key?: string; source: 'stored' | 'env' | 'none' } {
    const stored = this.cached?.apiKey ?? ''
    if (stored) {
      if (!isEncryptedSecret(stored)) return { key: stored, source: 'stored' }
      try {
        const key = this.codec.decrypt(stored).trim()
        if (key) return { key, source: 'stored' }
      } catch (error) {
        if (error instanceof SecretProtectionUnavailableError) this.protectionUnavailable = true
        else this.needsKeyReentry = true
      }
    }
    const env = this.envKey()
    return env ? { key: env, source: 'env' } : { key: undefined, source: 'none' }
  }

  async publicView(): Promise<VoiceSettingsPublic> {
    await this.load()
    const stored = this.cached ?? defaults()
    const resolved = this.resolveKey()
    return {
      keyConfigured: resolved.source === 'stored',
      envKeyAvailable: Boolean(this.envKey()),
      needsKeyReentry: this.needsKeyReentry,
      protectionUnavailable: this.protectionUnavailable,
      loadError: this.loadError,
      voice: stored.voice,
      speed: stored.speed,
      autoSpeak: stored.autoSpeak,
      baseUrl: stored.baseUrl,
      sttModel: STT_MODEL,
      ttsModel: TTS_MODEL
    }
  }

  async runtime(): Promise<VoiceRuntimeSettings> {
    await this.load()
    const stored = this.cached ?? defaults()
    return {
      voice: stored.voice,
      speed: stored.speed,
      autoSpeak: stored.autoSpeak,
      baseUrl: stored.baseUrl,
      sttModel: STT_MODEL,
      ttsModel: TTS_MODEL
    }
  }

  async apiKey(): Promise<{ key?: string; source: 'stored' | 'env' | 'none' }> {
    await this.load()
    return this.resolveKey()
  }

  async save(patch: VoiceSettingsPatch): Promise<VoiceSettingsPublic> {
    await this.load()
    const next: StoredVoice = { ...(this.cached ?? defaults()) }
    if (patch.clearKey) next.apiKey = ''
    if (patch.importEnvKey) {
      const env = this.envKey()
      if (!env) throw new Error('环境变量里没有 SILICONFLOW_API_KEY。')
      next.apiKey = this.codec.encrypt(env)
    }
    if (patch.apiKey !== undefined) {
      const key = patch.apiKey.trim()
      if (!key) throw new Error('API Key 不能为空。')
      if (key.length > 512 || /[\r\n]/u.test(key)) throw new Error('API Key 格式无效。')
      next.apiKey = this.codec.encrypt(key)
    }
    if (patch.voice !== undefined) {
      if (!isVoicePresetId(patch.voice)) throw new Error('音色无效。')
      next.voice = patch.voice
    }
    if (patch.speed !== undefined) {
      if (typeof patch.speed !== 'number' || !Number.isFinite(patch.speed) ||
          patch.speed < 0.5 || patch.speed > 2) throw new Error('语速无效。')
      next.speed = clampSpeechSpeed(patch.speed)
    }
    if (patch.autoSpeak !== undefined) {
      if (typeof patch.autoSpeak !== 'boolean') throw new Error('自动朗读开关无效。')
      next.autoSpeak = patch.autoSpeak
    }
    if (patch.baseUrl !== undefined) next.baseUrl = validBaseUrl(patch.baseUrl)

    const write = this.writeChain.then(() => this.writeAtomic(next))
    this.writeChain = write.catch(() => undefined)
    await write
    this.cached = next
    this.loadError = false
    if (patch.clearKey || patch.apiKey !== undefined || patch.importEnvKey) {
      this.needsKeyReentry = false
      this.protectionUnavailable = false
    }
    return this.publicView()
  }

  private async writeAtomic(next: StoredVoice): Promise<void> {
    await fsp.mkdir(this.dataRoot, { recursive: true })
    const temporary = `${this.filePath}.tmp`
    const handle = await fsp.open(temporary, 'w')
    try {
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8')
      await handle.sync().catch(() => undefined)
    } finally {
      await handle.close()
    }
    await fsp.rename(temporary, this.filePath)
  }
}
