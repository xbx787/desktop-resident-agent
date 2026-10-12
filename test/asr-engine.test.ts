// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSpeechAsrEngine, SiliconFlowAsrEngine } from '../src/renderer/asr-engine'

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

function emitResult(target: MockSpeechRecognition, text: string, isFinal: boolean): void {
  const result = { isFinal, 0: { transcript: text }, length: 1 }
  const event = new Event('result') as Event & { resultIndex: number; results: unknown[] }
  event.resultIndex = 0
  event.results = [result]
  target.dispatchEvent(event)
}

function emitError(target: MockSpeechRecognition, error: SpeechRecognitionErrorCode): void {
  const event = new Event('error') as Event & { error: SpeechRecognitionErrorCode }
  event.error = error
  target.dispatchEvent(event)
}

describe('WebSpeechAsrEngine', () => {
  beforeEach(() => {
    Object.assign(globalThis, {
      SpeechRecognition: MockSpeechRecognition,
      webkitSpeechRecognition: MockSpeechRecognition,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits final result', async () => {
    const onFinal = vi.fn()
    const onStateChange = vi.fn()
    const engine = new WebSpeechAsrEngine({ onFinal, onStateChange })
    engine.start()
    await Promise.resolve()

    expect(onStateChange).toHaveBeenCalledWith(true)
    emitResult(engine['recognition'] as MockSpeechRecognition, 'hello', true)
    expect(onFinal).toHaveBeenCalledWith('hello')
  })

  it('reports network error', async () => {
    const onError = vi.fn()
    const onStateChange = vi.fn()
    const engine = new WebSpeechAsrEngine({ onError, onStateChange })
    engine.start()
    await Promise.resolve()

    emitError(engine['recognition'] as MockSpeechRecognition, 'network')
    expect(onError).toHaveBeenCalledWith('语音识别网络错误。')
    expect(onStateChange).toHaveBeenLastCalledWith(false)
  })
})

describe('SiliconFlowAsrEngine', () => {
  let mediaRecorderState = 'inactive'
  let dataHandler: ((event: BlobEvent) => void) | undefined
  let stopHandler: (() => void) | undefined
  let chunks: Blob[] = []

  class MockMediaRecorder extends EventTarget {
    static isTypeSupported = () => true
    mimeType = 'audio/webm'
    state = 'inactive'

    constructor() {
      super()
      mediaRecorderState = 'inactive'
      chunks = []
    }

    start(): void {
      this.state = 'recording'
      mediaRecorderState = 'recording'
    }

    stop(): void {
      this.state = 'inactive'
      mediaRecorderState = 'inactive'
      stopHandler?.()
    }

    addEventListener(type: string, handler: (event: Event) => void): void {
      if (type === 'dataavailable') dataHandler = handler as (event: BlobEvent) => void
      if (type === 'stop') stopHandler = handler as () => void
      super.addEventListener(type, handler)
    }
  }

  let transcribeMock: ReturnType<typeof vi.fn>
  let voiceLogMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    transcribeMock = vi.fn()
    voiceLogMock = vi.fn().mockResolvedValue(undefined)
    Object.assign(globalThis, {
      MediaRecorder: MockMediaRecorder,
      navigator: {
        mediaDevices: {
          getUserMedia: vi.fn(async () => ({
            getTracks: () => [{ stop: vi.fn() }],
          })),
        },
      },
    })
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('records and transcribes audio via bridge', async () => {
    transcribeMock.mockResolvedValueOnce({ text: '  hello world  ' })

    const onFinal = vi.fn()
    const onStateChange = vi.fn()
    const engine = new SiliconFlowAsrEngine(
      { available: true, model: 'm' },
      { transcribeAudio: transcribeMock, voiceLog: voiceLogMock },
      { onFinal, onStateChange }
    )

    engine.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onStateChange).toHaveBeenCalledWith(true)

    const blob = new Blob(['audio'], { type: 'audio/webm' })
    dataHandler?.({ data: blob } as BlobEvent)
    engine.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(transcribeMock.mock.calls[0]?.[0].bytes).toBeInstanceOf(Array)
    expect(transcribeMock.mock.calls[0]?.[0].bytes.length).toBeGreaterThan(0)
    expect(transcribeMock.mock.calls[0]?.[0]).not.toHaveProperty('apiKey')
    expect(onFinal).toHaveBeenCalledWith('hello world')
    expect(JSON.stringify(voiceLogMock.mock.calls)).not.toContain('hello world')
  })

  it('reports bridge error', async () => {
    transcribeMock.mockRejectedValueOnce(new Error('转写失败（401）：Unauthorized'))

    const onError = vi.fn()
    const engine = new SiliconFlowAsrEngine(
      { available: true },
      { transcribeAudio: transcribeMock, voiceLog: voiceLogMock },
      { onError }
    )

    engine.start()
    await new Promise((resolve) => setTimeout(resolve, 10))

    const blob = new Blob(['audio'], { type: 'audio/webm' })
    dataHandler?.({ data: blob } as BlobEvent)
    engine.stop()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(transcribeMock).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('转写失败（401）：Unauthorized')
    expect(JSON.stringify(voiceLogMock.mock.calls)).not.toContain('Unauthorized')
  })

  it('reports missing api key', () => {
    const onError = vi.fn()
    const engine = new SiliconFlowAsrEngine({ available: false }, { transcribeAudio: transcribeMock, voiceLog: voiceLogMock }, { onError })
    engine.start()
    expect(onError).toHaveBeenCalledWith('未配置 SiliconFlow API Key。')
  })
})
