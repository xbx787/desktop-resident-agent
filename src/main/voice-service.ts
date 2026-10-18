import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { VoiceConfig, VoiceJobProgress, VoiceSettingsPatch, VoiceSettingsPublic } from '../shared/contracts'
import { MAX_TTS_INPUT_CHARS, TTS_MODEL, clampSpeechSpeed, isSpeechSpeed, isVoicePresetId, siliconFlowVoiceName } from '../shared/voice'
import { transcribeAudio as defaultTranscribe } from './asr-server'
import { readDocumentForSpeech, convertDocumentToAudio } from './document-audio'
import type { SecretCodec } from './secret-storage'
import { VoiceCache } from './voice-cache'
import { VoiceConfigStore } from './voice-config-store'
import { synthesizeSpeech as defaultSynthesize } from './voice-tts-server'

export interface VoiceServiceOptions {
  dataRoot: string
  codec: SecretCodec
  env?: NodeJS.ProcessEnv
  onJobProgress?: (progress: VoiceJobProgress) => void
  synthesizeImpl?: typeof defaultSynthesize
  transcribeImpl?: typeof defaultTranscribe
  now?: () => Date
}

interface DocumentJob {
  id: string
  controller: AbortController
  outputDir?: string
  total: number
  progress: VoiceJobProgress
}

class Limiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }
}

export class VoiceService {
  private readonly store: VoiceConfigStore
  private readonly cache: VoiceCache
  private readonly limiter = new Limiter(2)
  private readonly jobs = new Map<string, DocumentJob>()
  private lastJob: VoiceJobProgress | undefined
  private readonly onJobProgress: (progress: VoiceJobProgress) => void
  private readonly synthesizeImpl: typeof defaultSynthesize
  private readonly transcribeImpl: typeof defaultTranscribe
  private readonly now: () => Date
  readonly audioRoot: string

  constructor(options: VoiceServiceOptions) {
    this.store = new VoiceConfigStore(options.dataRoot, options.codec, options.env)
    this.cache = new VoiceCache(path.join(options.dataRoot, 'voice-cache'))
    this.audioRoot = path.join(options.dataRoot, 'audio')
    this.onJobProgress = options.onJobProgress ?? (() => undefined)
    this.synthesizeImpl = options.synthesizeImpl ?? defaultSynthesize
    this.transcribeImpl = options.transcribeImpl ?? defaultTranscribe
    this.now = options.now ?? (() => new Date())
  }

  async getPublicSettings(): Promise<VoiceSettingsPublic> {
    const view = await this.store.publicView()
    return this.lastJob ? { ...view, lastDocumentJob: this.lastJob } : view
  }

  async saveSettings(patch: VoiceSettingsPatch): Promise<VoiceSettingsPublic> {
    await this.store.save(patch)
    return this.getPublicSettings()
  }

  async getVoiceConfig(): Promise<VoiceConfig> {
    const [key, runtime, view] = await Promise.all([
      this.store.apiKey(), this.store.runtime(), this.store.publicView()
    ])
    return {
      siliconFlowAvailable: Boolean(key.key),
      siliconFlowModel: runtime.sttModel,
      siliconFlowBaseUrl: runtime.baseUrl,
      ttsAvailable: Boolean(key.key),
      ttsModel: runtime.ttsModel,
      voice: runtime.voice,
      speed: runtime.speed,
      autoSpeak: runtime.autoSpeak,
      needsKeyReentry: view.needsKeyReentry
    }
  }

  async transcribe(input: { bytes: number[]; mimeType: string }): Promise<{ text: string }> {
    const key = await this.store.apiKey()
    if (!key.key) throw new Error('未配置 SiliconFlow API Key，请到设置 → 语音里填写。')
    const runtime = await this.store.runtime()
    return this.transcribeImpl({
      bytes: input.bytes,
      mimeType: input.mimeType,
      apiKey: key.key,
      model: runtime.sttModel,
      baseUrl: runtime.baseUrl
    })
  }

  async synthesize(input: { text: string; voice?: string; speed?: number }): Promise<{
    audioBase64: string
    mimeType: 'audio/mpeg'
    cached: boolean
  }> {
    const text = input.text.trim()
    if (!text) throw new Error('没有可朗读的文字。')
    if (text.length > MAX_TTS_INPUT_CHARS) throw new Error('单段语音最多 300 字。')
    const key = await this.store.apiKey()
    if (!key.key) throw new Error('未配置 SiliconFlow API Key，请到设置 → 语音里填写。')
    const runtime = await this.store.runtime()
    const voice = isVoicePresetId(input.voice) ? input.voice : runtime.voice
    const speed = isSpeechSpeed(input.speed) ? clampSpeechSpeed(input.speed) : runtime.speed
    const voiceName = siliconFlowVoiceName(voice)
    const cacheKey = this.cache.keyFor({ model: TTS_MODEL, voice: voiceName, speed, format: 'mp3', text })

    const hit = await this.cache.read(cacheKey)
    if (hit) return { audioBase64: hit.toString('base64'), mimeType: 'audio/mpeg', cached: true }

    const result = await this.limiter.run(() => this.synthesizeImpl({
      text,
      apiKey: key.key!,
      baseUrl: runtime.baseUrl,
      model: TTS_MODEL,
      voice: voiceName,
      speed
    }))
    await this.cache.write(cacheKey, result.bytes)
    return { audioBase64: result.bytes.toString('base64'), mimeType: 'audio/mpeg', cached: false }
  }

  async testConnection(input: { apiKey?: string; voice?: string; speed?: number } = {}): Promise<{ ok: boolean; message: string }> {
    try {
      const stored = await this.store.apiKey()
      const apiKey = input.apiKey?.trim() || stored.key
      if (!apiKey) return { ok: false, message: '还没有填写 SiliconFlow API Key。' }
      const runtime = await this.store.runtime()
      await this.synthesizeImpl({
        text: '你好，我是小鲸。',
        apiKey,
        baseUrl: runtime.baseUrl,
        model: TTS_MODEL,
        voice: siliconFlowVoiceName(isVoicePresetId(input.voice) ? input.voice : runtime.voice),
        speed: isSpeechSpeed(input.speed) ? input.speed : runtime.speed,
        timeoutMs: 30_000
      })
      return { ok: true, message: '连接成功，语音合成可用。' }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '连接失败。' }
    }
  }

  async startDocumentJob(filePath: string): Promise<{ jobId: string; total: number }> {
    const document = await readDocumentForSpeech(filePath)
    const key = await this.store.apiKey()
    if (!key.key) throw new Error('未配置 SiliconFlow API Key，请到设置 → 语音里填写。')
    const runtime = await this.store.runtime()
    const jobId = randomUUID()
    const controller = new AbortController()
    const progress: VoiceJobProgress = {
      jobId, phase: 'preparing', completed: 0, total: document.segments.length
    }
    const job: DocumentJob = { id: jobId, controller, total: document.segments.length, progress }
    this.jobs.set(jobId, job)
    this.publish(progress)

    void (async () => {
      try {
        const result = await convertDocumentToAudio({
          jobId,
          name: document.name,
          segments: document.segments,
          audioRoot: this.audioRoot,
          voice: isVoicePresetId(runtime.voice) ? runtime.voice : 'claire',
          speed: runtime.speed,
          signal: controller.signal,
          now: this.now(),
          synthesize: (text, signal) => this.limiter.run(async () => {
            const cacheKey = this.cache.keyFor({
              model: TTS_MODEL, voice: siliconFlowVoiceName(runtime.voice), speed: runtime.speed, format: 'mp3', text
            })
            const hit = await this.cache.read(cacheKey)
            if (hit) return hit
            const synthesized = await this.synthesizeImpl({
              text,
              apiKey: key.key!,
              baseUrl: runtime.baseUrl,
              model: TTS_MODEL,
              voice: siliconFlowVoiceName(runtime.voice),
              speed: runtime.speed,
              signal
            })
            await this.cache.write(cacheKey, synthesized.bytes)
            return synthesized.bytes
          }),
          onProgress: (next) => {
            job.outputDir = next.outputDir ?? job.outputDir
            job.progress = next
            this.publish(next)
          }
        })
        job.progress = {
          jobId, phase: result.status === 'completed' ? 'done' : 'cancelled',
          completed: result.completed, total: result.total, outputDir: result.outputDir
        }
        this.publish(job.progress)
      } catch (error) {
        job.progress = {
          jobId, phase: 'failed', completed: job.progress.completed, total: job.total,
          outputDir: job.outputDir,
          message: error instanceof Error ? error.message : '文档转音频失败。'
        }
        this.publish(job.progress)
      } finally {
        this.jobs.delete(jobId)
      }
    })()

    return { jobId, total: document.segments.length }
  }

  async cancelDocumentJob(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId)
    if (!job) return
    job.controller.abort()
  }

  /** Resolves an output path only when it belongs to a known job under audio/. */
  async documentOutputPath(jobId: string): Promise<string> {
    const job = this.jobs.get(jobId)
    const outputDir = job?.outputDir ?? (this.lastJob?.jobId === jobId ? this.lastJob.outputDir : undefined)
    if (!outputDir) throw new Error('找不到这个音频任务。')
    const relative = path.relative(this.audioRoot, outputDir)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('音频目录无效。')
    return outputDir
  }

  dispose(): void {
    for (const job of this.jobs.values()) job.controller.abort()
    this.jobs.clear()
  }

  private publish(progress: VoiceJobProgress): void {
    this.lastJob = progress
    try {
      this.onJobProgress(progress)
    } catch {
      // A closed settings window must not break a running job.
    }
  }
}
