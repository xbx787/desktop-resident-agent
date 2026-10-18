export interface TtsEvents {
  onSpeakStart?: () => void
  onSpeakEnd?: () => void
  onError?: (message: string) => void
}

export interface TtsEngine {
  readonly available: boolean
  readonly speaking: boolean
  /** Returns false when there is nothing to say or no engine is available. */
  speak(text: string): boolean
  stopSpeaking(): void
  destroy(): void
}

function pickChineseVoice(): SpeechSynthesisVoice | undefined {
  const voices = speechSynthesis.getVoices()
  const zh = voices.find((v) => v.lang.toLowerCase().startsWith('zh'))
  if (zh) return zh
  const zhHans = voices.find((v) => v.lang.toLowerCase().includes('hans'))
  if (zhHans) return zhHans
  const zhTw = voices.find(
    (v) => v.lang.toLowerCase().startsWith('zh-tw') || v.lang.toLowerCase().startsWith('zh-hk')
  )
  return zhTw
}

export class BrowserTtsEngine implements TtsEngine {
  private _speaking = false
  private currentUtterance: SpeechSynthesisUtterance | undefined
  private readonly events: Required<TtsEvents>
  private destroyed = false

  constructor(events: TtsEvents = {}) {
    this.events = {
      onSpeakStart: events.onSpeakStart ?? (() => {}),
      onSpeakEnd: events.onSpeakEnd ?? (() => {}),
      onError: events.onError ?? (() => {}),
    }
  }

  get available(): boolean {
    return typeof speechSynthesis !== 'undefined'
  }

  get speaking(): boolean {
    return this._speaking
  }

  speak(text: string): boolean {
    if (!text.trim()) return false
    if (!this.available) {
      this.events.onError('本机不支持语音合成。')
      return false
    }
    this.stopSpeaking()

    const sentences = text
      .replace(/([。！？.!?;；])/gu, '$1\n')
      .split(/\r?\n/u)
      .map((s) => s.trim())
      .filter(Boolean)

    if (sentences.length === 0) return false

    this._speaking = true
    this.events.onSpeakStart()

    let index = 0
    const speakNext = (): void => {
      if (this.destroyed || !this._speaking) return
      if (index >= sentences.length) {
        this._speaking = false
        this.events.onSpeakEnd()
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
        this.currentUtterance = undefined
        this.events.onError('语音合成播放失败。')
      }
      this.currentUtterance = utterance
      speechSynthesis.speak(utterance)
    }

    speakNext()
    return true
  }

  stopSpeaking(): void {
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.cancel()
    }
    this.currentUtterance = undefined
    if (this._speaking) {
      this._speaking = false
      this.events.onSpeakEnd()
    }
  }

  destroy(): void {
    this.destroyed = true
    this.stopSpeaking()
  }
}
