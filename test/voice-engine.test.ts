// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BrowserVoiceEngine } from '../src/renderer/voice-engine'

class MockSpeechRecognition extends EventTarget {
  lang = ''
  interimResults = false
  maxAlternatives = 1
  continuous = false
  started = false

  start(): void {
    this.started = true
    queueMicrotask(() => this.dispatchEvent(new Event('start')))
  }

  stop(): void {
    this.started = false
    queueMicrotask(() => this.dispatchEvent(new Event('end')))
  }
}

function emitResult(target: MockSpeechRecognition, text: string, isFinal: boolean): void {
  const result = {
    isFinal,
    0: { transcript: text },
    length: 1,
  }
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

describe('BrowserVoiceEngine', () => {
  let recognitionCtor: Mock<() => MockSpeechRecognition>
  let lastInstance: MockSpeechRecognition | undefined

  beforeEach(() => {
    lastInstance = undefined
    recognitionCtor = vi.fn(() => {
      const instance = new MockSpeechRecognition()
      lastInstance = instance
      return instance
    })
    Object.assign(globalThis, {
      SpeechRecognition: recognitionCtor as unknown as SpeechRecognitionStatic,
      webkitSpeechRecognition: recognitionCtor as unknown as SpeechRecognitionStatic,
    })
    Object.assign(globalThis, {
      speechSynthesis: {
        cancel: vi.fn(),
        speak: vi.fn(),
        getVoices: vi.fn(() => []),
        onvoiceschanged: null,
      },
      SpeechSynthesisUtterance: vi.fn(function (this: SpeechSynthesisUtterance, text: string) {
        this.text = text
        this.lang = ''
        this.voice = null
        this.rate = 1
        this.pitch = 1
        this.onend = null
        this.onerror = null
      }),
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports availability when SpeechRecognition and speechSynthesis exist', () => {
    const engine = new BrowserVoiceEngine()
    expect(engine.available).toBe(true)
  })

  it('emits listening state and partial results', async () => {
    const onStateChange = vi.fn()
    const onPartial = vi.fn()
    const engine = new BrowserVoiceEngine({ onStateChange, onPartial })
    engine.startListen()
    await Promise.resolve()

    expect(lastInstance?.started).toBe(true)
    expect(onStateChange).toHaveBeenCalledWith('listening')

    emitResult(lastInstance!, '你好', false)
    expect(onPartial).toHaveBeenCalledWith('你好')
  })

  it('emits final result and switches to processing', async () => {
    const onFinal = vi.fn()
    const engine = new BrowserVoiceEngine({ onFinal })
    engine.startListen()
    await Promise.resolve()

    emitResult(lastInstance!, '你好世界', true)
    expect(onFinal).toHaveBeenCalledWith('你好世界')
  })

  it('reports error when recognition fails', async () => {
    const onError = vi.fn()
    const engine = new BrowserVoiceEngine({ onError })
    engine.startListen()
    await Promise.resolve()

    emitError(lastInstance!, 'not-allowed')
    expect(onError).toHaveBeenCalledWith('麦克风权限被拒绝。')
  })
})
