import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SiliconFlowTtsEngine } from '../src/renderer/siliconflow-tts-engine'
import type { TtsEngine } from '../src/renderer/tts-engine'

class FakeAudio {
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  src: string
  constructor(url: string) { this.src = url }
  play(): Promise<void> {
    queueMicrotask(() => this.onended?.())
    return Promise.resolve()
  }
  pause(): void {}
}

const originalCreate = Object.getOwnPropertyDescriptor(URL, 'createObjectURL')
const originalRevoke = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL')

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio)
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:test') })
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  vi.unstubAllGlobals()
  if (originalCreate) Object.defineProperty(URL, 'createObjectURL', originalCreate)
  else Reflect.deleteProperty(URL, 'createObjectURL')
  if (originalRevoke) Object.defineProperty(URL, 'revokeObjectURL', originalRevoke)
  else Reflect.deleteProperty(URL, 'revokeObjectURL')
})

const longText = `${'第一段'.repeat(40)}。${'第二段'.repeat(40)}。`

function bridge() {
  return {
    synthesizeSpeech: vi.fn(async () => ({
      audioBase64: Buffer.from('audio-bytes').toString('base64'),
      mimeType: 'audio/mpeg',
      cached: false
    }))
  }
}

describe('SiliconFlowTtsEngine', () => {
  it('synthesizes each segment in order and reports the end', async () => {
    const api = bridge()
    const starts: number[] = []
    await new Promise<void>((resolve, reject) => {
      const engine = new SiliconFlowTtsEngine({ voice: 'claire', speed: 1 }, api, {
        onSpeakStart: () => starts.push(1),
        onSpeakEnd: resolve,
        onError: reject
      })
      expect(engine.speak(longText)).toBe(true)
    })
    expect(api.synthesizeSpeech).toHaveBeenCalledTimes(2)
    expect(starts).toHaveLength(1)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })

  it('stops asking for more segments after stopSpeaking', async () => {
    const api = {
      synthesizeSpeech: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { audioBase64: Buffer.from('a').toString('base64'), mimeType: 'audio/mpeg', cached: false }
      })
    }
    const end = vi.fn()
    const engine = new SiliconFlowTtsEngine({ voice: 'claire', speed: 1 }, api, { onSpeakEnd: end })
    engine.speak(longText)
    engine.stopSpeaking()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.synthesizeSpeech).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalled()
  })

  it('falls back to the system voice when the first request fails', async () => {
    const api = { synthesizeSpeech: vi.fn(async () => { throw new Error('语音合成失败（500）。') }) }
    const fallback: TtsEngine = {
      available: true,
      speaking: false,
      speak: vi.fn(() => true),
      stopSpeaking: vi.fn(),
      destroy: vi.fn()
    }
    const errors = vi.fn()
    await new Promise<void>((resolve) => {
      const engine = new SiliconFlowTtsEngine({ voice: 'claire', speed: 1 }, api, {
        onSpeakEnd: resolve,
        onError: errors
      }, fallback)
      expect(engine.speak('你好。')).toBe(true)
    })
    expect(fallback.speak).toHaveBeenCalledWith('你好。')
    expect(errors).not.toHaveBeenCalled()
  })

  it('returns false for empty or code-only text', () => {
    const engine = new SiliconFlowTtsEngine({ voice: 'claire', speed: 1 }, bridge())
    expect(engine.speak('```\nonly code\n```')).toBe(false)
  })
})
