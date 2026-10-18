import { segmentForSpeech } from '../shared/speech-text'
import type { TtsEngine, TtsEvents } from './tts-engine'

export interface SpeechSynthesisBridge {
  synthesizeSpeech(request: { text: string; voice?: string; speed?: number }): Promise<{
    audioBase64: string
    mimeType: string
    cached: boolean
  }>
}

interface SynthesisConfig {
  voice: string
  speed: number
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Cloud TTS: synthesize one segment in the main process, play it here. The
 *  browser engine stays as a fallback when the first request fails before any
 *  audio has played. */
export class SiliconFlowTtsEngine implements TtsEngine {
  private _speaking = false
  private generation = 0
  private currentAudio: HTMLAudioElement | undefined
  private currentUrl: string | undefined
  private destroyed = false
  private readonly events: Required<TtsEvents>

  constructor(
    private config: SynthesisConfig,
    private readonly bridge: SpeechSynthesisBridge,
    events: TtsEvents = {},
    private readonly fallback?: TtsEngine
  ) {
    this.events = {
      onSpeakStart: events.onSpeakStart ?? (() => {}),
      onSpeakEnd: events.onSpeakEnd ?? (() => {}),
      onError: events.onError ?? (() => {})
    }
  }

  get available(): boolean {
    return typeof Audio !== 'undefined' && typeof URL.createObjectURL === 'function'
  }

  get speaking(): boolean {
    return this._speaking
  }

  updateConfig(config: SynthesisConfig): void {
    this.config = config
  }

  speak(text: string): boolean {
    if (this.destroyed) return false
    const segments = segmentForSpeech(text)
    if (!segments.length) return false
    if (!this.available) {
      this.events.onError('当前环境无法播放语音。')
      return false
    }
    this.stopSpeaking()
    const generation = ++this.generation
    this._speaking = true
    this.events.onSpeakStart()
    void this.playAll(segments.map((segment) => segment.text), generation, text)
    return true
  }

  stopSpeaking(): void {
    this.generation += 1
    if (this.currentAudio) {
      this.currentAudio.pause()
      this.currentAudio.src = ''
      this.currentAudio = undefined
    }
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl)
      this.currentUrl = undefined
    }
    if (this._speaking) {
      this._speaking = false
      this.events.onSpeakEnd()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopSpeaking()
    this.fallback?.destroy()
  }

  private async playAll(segments: string[], generation: number, original: string): Promise<void> {
    let played = false
    try {
      for (const segment of segments) {
        if (this.destroyed || generation !== this.generation) return
        const result = await this.bridge.synthesizeSpeech({
          text: segment,
          voice: this.config.voice,
          speed: this.config.speed
        })
        if (this.destroyed || generation !== this.generation) return
        await this.playBytes(base64Bytes(result.audioBase64), result.mimeType, generation)
        played = true
      }
      if (generation !== this.generation) return
      this._speaking = false
      this.events.onSpeakEnd()
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return
      this._speaking = false
      if (!played && this.fallback?.available) {
        // Nothing has been heard yet; let the system voice read it instead.
        if (this.fallback.speak(original)) {
          this.events.onSpeakEnd()
          return
        }
      }
      this.events.onSpeakEnd()
      this.events.onError(error instanceof Error ? error.message : '语音播放失败。')
    }
  }

  private async playBytes(bytes: Uint8Array, mimeType: string, generation: number): Promise<void> {
    const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    const blob = new Blob([copy], { type: mimeType || 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    const audio = new Audio(url)
    this.currentAudio = audio
    this.currentUrl = url
    try {
      await new Promise<void>((resolve, reject) => {
        audio.onended = () => resolve()
        audio.onerror = () => reject(new Error('语音播放失败。'))
        const played = audio.play()
        if (played && typeof played.catch === 'function') played.catch(() => reject(new Error('语音播放被系统阻止。')))
        if (generation !== this.generation) resolve()
      })
    } finally {
      if (this.currentAudio === audio) this.currentAudio = undefined
      if (this.currentUrl === url) {
        URL.revokeObjectURL(url)
        this.currentUrl = undefined
      }
    }
  }
}
