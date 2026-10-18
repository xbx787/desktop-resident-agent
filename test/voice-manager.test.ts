// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AppSnapshot, PetAPI } from '../src/shared/contracts'
import { VoiceManager } from '../src/renderer/voice-manager'

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
  const result = { isFinal, 0: { transcript: text }, length: 1 }
  const event = new Event('result') as Event & { resultIndex: number; results: unknown[] }
  event.resultIndex = 0
  event.results = [result]
  target.dispatchEvent(event)
}

function createBridge(): PetAPI {
  return {
    getSnapshot: vi.fn(async () => ({ mode: 'demo', modelReady: false, claudeCodeReady: false, avatarState: 'idle', taskStatus: 'idle', timeline: [], timelineRevision: 0 }) as AppSnapshot),
    sendMessage: vi.fn(async () => undefined),
    approveAction: vi.fn(async () => undefined),
    rejectAction: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    showPanel: vi.fn(async () => undefined),
    hidePanel: vi.fn(async () => undefined),
    getPanelOpen: vi.fn(async () => false),
    onPanelOpen: vi.fn(() => () => {}),
    setMenuOpen: vi.fn(async () => undefined),
    setBalanceOpen: vi.fn(async () => undefined),
    onBalanceOpen: vi.fn(() => () => {}),
    getBalance: vi.fn(async () => ({ available: false, balances: [], checkedAt: new Date().toISOString() })),
    setBubbleLayout: vi.fn(async () => undefined),
    setModelMode: vi.fn(async () => undefined),
    setAvatarState: vi.fn(async () => undefined),
    quit: vi.fn(async () => undefined),
    beginDrag: vi.fn(async () => undefined),
    dragMove: vi.fn(async () => undefined),
    endDrag: vi.fn(async () => undefined),
    onSnapshot: vi.fn(() => () => {}),
  } as unknown as PetAPI
}

describe('VoiceManager', () => {
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

  it('starts listening and reports phase changes', async () => {
    const bridge = createBridge()
    const onPhaseChange = vi.fn()
    const manager = new VoiceManager(bridge, { onPhaseChange })
    manager.start()
    await Promise.resolve()
    expect(onPhaseChange).toHaveBeenCalledWith('listening')
    manager.destroy()
  })

  it('submits final text and enters processing', async () => {
    const bridge = createBridge()
    const onRequestText = vi.fn(async () => undefined)
    const onPhaseChange = vi.fn()
    const manager = new VoiceManager(bridge, { onRequestText, onPhaseChange })
    manager.start()
    await Promise.resolve()

    emitResult(lastInstance!, '记录测试', true)
    await Promise.resolve()

    expect(onRequestText).toHaveBeenCalledWith('记录测试')
    expect(onPhaseChange).toHaveBeenCalledWith('processing')
    manager.destroy()
  })

  it('sets avatar state for listening and speaking', async () => {
    const bridge = createBridge()
    const manager = new VoiceManager(bridge)
    manager.start()
    await Promise.resolve()
    expect(bridge.setAvatarState).toHaveBeenCalledWith('listening')
    manager.stop()
    expect(bridge.setAvatarState).toHaveBeenCalledWith('idle')
    manager.destroy()
  })

  it('triggers TTS when task completes', async () => {
    const bridge = createBridge()
    const manager = new VoiceManager(bridge)
    manager.start()
    await Promise.resolve()

    emitResult(lastInstance!, '测试', true)
    await Promise.resolve()

    manager.updateFromSnapshot({
      mode: 'demo',
      modelReady: false,
      claudeCodeReady: false,
      timelineRevision: 1,
      avatarState: 'idle',
      taskStatus: 'done',
      timeline: [
        { id: '0', time: new Date().toISOString(), kind: 'user', text: '测试' },
        { id: '1', time: new Date().toISOString(), kind: 'assistant', text: '这是回复' }
      ],
    })
    expect(globalThis.speechSynthesis.speak).toHaveBeenCalled()
    manager.destroy()
  })
})
