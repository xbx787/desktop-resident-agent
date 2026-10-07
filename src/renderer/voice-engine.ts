export type VoicePhase = 'idle' | 'listening' | 'speaking'

export interface VoiceEngineEvents {
  onStateChange?: (phase: VoicePhase) => void
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (message: string) => void
  onSpeakStart?: () => void
  onSpeakEnd?: () => void
}

export interface VoiceEngine {
  readonly available: boolean
  readonly listening: boolean
  readonly speaking: boolean
  startListen(): void
  stopListen(): void
  speak(text: string): void
  stopSpeaking(): void
  destroy(): void
}

interface SpeechRecognitionCtor {
  new (): SpeechRecognition
}

function pickChineseVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices()
  const zh = voices.find((v) => v.lang.toLowerCase().startsWith('zh'))
  if (zh) return zh
  const zhHans = voices.find((v) => v.lang.toLowerCase().includes('hans'))
  if (zhHans) return zhHans
  const zhTw = voices.find((v) => v.lang.toLowerCase().startsWith('zh-tw') || v.lang.toLowerCase().startsWith('zh-hk'))
  return zhTw
}

export class BrowserVoiceEngine implements VoiceEngine {
  private readonly Recognition: SpeechRecognitionCtor | undefined
  private recognition: SpeechRecognition | undefined
  private pendingFinal = ''
  private _speaking = false
  private _listening = false
  private currentUtterance: SpeechSynthesisUtterance | undefined
  private voicesReady = false
  private readonly events: Required<VoiceEngineEvents>
  private destroyed = false

  constructor(events: VoiceEngineEvents = {}) {
    this.events = {
      onStateChange: events.onStateChange ?? (() => {}),
      onPartial: events.onPartial ?? (() => {}),
      onFinal: events.onFinal ?? (() => {}),
      onError: events.onError ?? (() => {}),
      onSpeakStart: events.onSpeakStart ?? (() => {}),
      onSpeakEnd: events.onSpeakEnd ?? (() => {}),
    }

    const ctor =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionCtor }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionCtor }).webkitSpeechRecognition
    this.Recognition = ctor

    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.onvoiceschanged = () => {
        this.voicesReady = true
      }
      this.voicesReady = speechSynthesis.getVoices().length > 0
    }
  }

  get available(): boolean {
    return Boolean(this.Recognition) && typeof speechSynthesis !== 'undefined'
  }

  get listening(): boolean {
    return this._listening
  }

  get speaking(): boolean {
    return this._speaking
  }

  startListen(): void {
    if (!this.Recognition) {
      this.events.onError('本机不支持语音识别。')
      return
    }
    if (this._listening) return
    this.stopSpeaking()

    try {
      this.recognition = new this.Recognition()
      this.recognition.lang = 'zh-CN'
      this.recognition.interimResults = true
      this.recognition.maxAlternatives = 1
      this.recognition.continuous = false

      this.recognition.addEventListener('start', () => {
        if (this.destroyed) return
        this._listening = true
        this.pendingFinal = ''
        this.events.onStateChange('listening')
      })

      this.recognition.addEventListener('result', (event: Event) => {
        if (this.destroyed) return
        const resultEvent = event as SpeechRecognitionEvent
        let interim = ''
        let final = ''
        for (let i = resultEvent.resultIndex; i < resultEvent.results.length; i++) {
          const result = resultEvent.results[i]
          const text = result[0]?.transcript ?? ''
          if (result.isFinal) final += text
          else interim += text
        }
        if (final) {
          this.pendingFinal += final
          this.events.onFinal(this.pendingFinal.trim())
          this.pendingFinal = ''
        }
        if (interim) {
          this.events.onPartial((this.pendingFinal + interim).trim())
        }
      })

      this.recognition.addEventListener('error', (event: Event) => {
        if (this.destroyed) return
        const reason = (event as SpeechRecognitionErrorEvent).error
        if (reason === 'aborted' || reason === 'no-speech') {
          this._listening = false
          this.events.onStateChange('idle')
          return
        }
        this._listening = false
        const message =
          reason === 'not-allowed'
            ? '麦克风权限被拒绝。'
            : reason === 'service-not-allowed'
              ? '语音识别服务不可用。'
              : reason === 'network'
                ? '语音识别网络错误。'
                : `语音识别出错（${reason}）。`
        this.events.onError(message)
        this.events.onStateChange('idle')
      })

      this.recognition.addEventListener('end', () => {
        if (this.destroyed) return
        this._listening = false
        if (!this._speaking) this.events.onStateChange('idle')
        this.recognition = undefined
      })

      this.recognition.start()
    } catch (error) {
      this._listening = false
      this.events.onError(error instanceof Error ? error.message : '无法启动语音识别。')
      this.events.onStateChange('idle')
    }
  }

  stopListen(): void {
    if (this.recognition && this._listening) {
      try {
        this.recognition.stop()
      } catch {
        // ignore
      }
    }
    this._listening = false
    this.recognition = undefined
  }

  speak(text: string): void {
    if (!text.trim()) return
    if (typeof speechSynthesis === 'undefined') {
      this.events.onError('本机不支持语音合成。')
      return
    }
    this.stopSpeaking()
    this.stopListen()

    const sentences = text
      .replace(/([。！？.!?;；])/gu, '$1\n')
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .filter(Boolean)

    if (sentences.length === 0) return

    this._speaking = true
    this.events.onStateChange('speaking')
    this.events.onSpeakStart()

    let index = 0
    const speakNext = (): void => {
      if (this.destroyed || !this._speaking) return
      if (index >= sentences.length) {
        this._speaking = false
        this.events.onSpeakEnd()
        this.events.onStateChange('idle')
        this.currentUtterance = undefined
        return
      }
      const utterance = new SpeechSynthesisUtterance(sentences[index])
      utterance.lang = 'zh-CN'
      const voice = pickChineseVoice()
      if (voice) utterance.voice = voice
      utterance.rate = 1.05
      utterance.pitch = 1.0
      utterance.onend = () => {
        index++
        speakNext()
      }
      utterance.onerror = () => {
        this._speaking = false
        this.events.onSpeakEnd()
        this.events.onStateChange('idle')
        this.currentUtterance = undefined
        this.events.onError('语音合成播放失败。')
      }
      this.currentUtterance = utterance
      speechSynthesis.speak(utterance)
    }

    speakNext()
  }

  stopSpeaking(): void {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel()
    }
    this.currentUtterance = undefined
    if (this._speaking) {
      this._speaking = false
      this.events.onSpeakEnd()
      this.events.onStateChange('idle')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopListen()
    this.stopSpeaking()
  }
}
