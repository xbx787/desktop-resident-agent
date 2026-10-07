export interface AsrEvents {
  onStateChange?: (listening: boolean) => void
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (message: string) => void
}

export interface AsrEngine {
  readonly available: boolean
  readonly listening: boolean
  start(): void
  stop(): void
  destroy(): void
}

class MockSpeechRecognition extends EventTarget {
  lang = ''
  interimResults = false
  maxAlternatives = 1
  continuous = false

  start(): void {
    queueMicrotask(() => this.dispatchEvent(new Event('start')))
  }

  stop(): void {
    queueMicrotask(() => this.dispatchEvent(new Event('end')))
  }
}

export class WebSpeechAsrEngine implements AsrEngine {
  private readonly Recognition: SpeechRecognitionStatic | undefined
  private recognition: SpeechRecognition | undefined
  private pendingFinal = ''
  private _listening = false
  private destroyed = false
  private readonly events: Required<AsrEvents>

  constructor(events: AsrEvents = {}) {
    this.events = {
      onStateChange: events.onStateChange ?? (() => {}),
      onPartial: events.onPartial ?? (() => {}),
      onFinal: events.onFinal ?? (() => {}),
      onError: events.onError ?? (() => {}),
    }

    this.Recognition =
      (window as unknown as { SpeechRecognition?: SpeechRecognitionStatic }).SpeechRecognition ??
      (window as unknown as { webkitSpeechRecognition?: SpeechRecognitionStatic }).webkitSpeechRecognition
  }

  get available(): boolean {
    return Boolean(this.Recognition)
  }

  get listening(): boolean {
    return this._listening
  }

  start(): void {
    if (!this.Recognition) {
      this.events.onError('本机不支持 Web Speech 识别。')
      return
    }
    if (this._listening) return
    this.stop()

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
        this.events.onStateChange(true)
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
          this.events.onStateChange(false)
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
        this.events.onStateChange(false)
      })

      this.recognition.addEventListener('end', () => {
        if (this.destroyed) return
        this._listening = false
        this.events.onStateChange(false)
        this.recognition = undefined
      })

      this.recognition.start()
    } catch (error) {
      this._listening = false
      this.events.onError(error instanceof Error ? error.message : '无法启动语音识别。')
      this.events.onStateChange(false)
    }
  }

  stop(): void {
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

  destroy(): void {
    this.destroyed = true
    this.stop()
  }
}

export interface SiliconFlowAsrConfig {
  apiKey: string
  baseUrl?: string
  model?: string
}

export class SiliconFlowAsrEngine implements AsrEngine {
  private mediaRecorder: MediaRecorder | undefined
  private chunks: Blob[] = []
  private stream: MediaStream | undefined
  private _listening = false
  private destroyed = false
  private abortController: AbortController | undefined
  private readonly events: Required<AsrEvents>

  constructor(
    private readonly config: SiliconFlowAsrConfig,
    events: AsrEvents = {}
  ) {
    this.events = {
      onStateChange: events.onStateChange ?? (() => {}),
      onPartial: events.onPartial ?? (() => {}),
      onFinal: events.onFinal ?? (() => {}),
      onError: events.onError ?? (() => {}),
    }
  }

  get available(): boolean {
    return Boolean(this.config.apiKey) && typeof MediaRecorder !== 'undefined'
  }

  get listening(): boolean {
    return this._listening
  }

  start(): void {
    if (this._listening) return
    if (!this.config.apiKey) {
      this.events.onError('未配置 SiliconFlow API Key。')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices) {
      this.events.onError('当前环境无法访问麦克风。')
      return
    }

    this.stop()
    this.chunks = []
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (this.destroyed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        this.stream = stream
        const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : undefined
        this.mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
        this.mediaRecorder.addEventListener('dataavailable', (event) => {
          if (event.data.size > 0) this.chunks.push(event.data)
        })
        this.mediaRecorder.addEventListener('stop', () => {
          void this.transcribe()
        })
        this.mediaRecorder.start(200)
        this._listening = true
        this.events.onStateChange(true)
        this.events.onPartial('正在录音…')
      })
      .catch((error: Error) => {
        const message = error.name === 'NotAllowedError' ? '麦克风权限被拒绝。' : `无法访问麦克风：${error.message}`
        this.events.onError(message)
        this.events.onStateChange(false)
      })
  }

  stop(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop()
      } catch {
        // ignore
      }
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = undefined
    }
    this._listening = false
  }

  destroy(): void {
    this.destroyed = true
    this.abortController?.abort()
    this.stop()
  }

  private async transcribe(): Promise<void> {
    if (this.destroyed || this.chunks.length === 0) return
    const blob = new Blob(this.chunks, { type: this.mediaRecorder?.mimeType ?? 'audio/webm' })
    this.chunks = []

    if (blob.size === 0) {
      this.events.onError('录音为空，请再说一次。')
      this.events.onStateChange(false)
      return
    }

    const form = new FormData()
    form.append('file', blob, 'recording.webm')
    form.append('model', this.config.model ?? 'FunAudioLLM/SenseVoiceSmall')

    const baseUrl = (this.config.baseUrl ?? 'https://api.siliconflow.com').replace(/\/$/, '')
    this.abortController = new AbortController()
    try {
      const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: form,
        signal: this.abortController.signal,
      })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`转写失败（${response.status}）：${body || response.statusText}`)
      }
      const data = (await response.json()) as { text?: string }
      const text = data.text?.trim() ?? ''
      if (text) {
        this.events.onFinal(text)
      } else {
        this.events.onError('转写结果为空。')
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
      this.events.onError(error instanceof Error ? error.message : '在线转写出错。')
    } finally {
      this.abortController = undefined
      this.events.onStateChange(false)
    }
  }
}
