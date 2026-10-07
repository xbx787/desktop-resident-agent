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

  beforeEach(() => {
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

  it('records and transcribes audio', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: '  hello world  ' }),
    } as Response)

    const onFinal = vi.fn()
    const onStateChange = vi.fn()
    const engine = new SiliconFlowAsrEngine(
      { apiKey: 'sk-test', model: 'm' },
      { onFinal, onStateChange }
    )

    engine.start()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(onStateChange).toHaveBeenCalledWith(true)

    const blob = new Blob(['audio'], { type: 'audio/webm' })
    dataHandler?.({ data: blob } as BlobEvent)
    engine.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(onFinal).toHaveBeenCalledWith('hello world')
  })

  it('reports missing api key', () => {
    const onError = vi.fn()
    const engine = new SiliconFlowAsrEngine({ apiKey: '' }, { onError })
    engine.start()
    expect(onError).toHaveBeenCalledWith('未配置 SiliconFlow API Key。')
  })
})
