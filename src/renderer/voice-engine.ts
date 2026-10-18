import type { AsrEngine, AsrEvents, TranscribeBridge } from './asr-engine'
import { WebSpeechAsrEngine, SiliconFlowAsrEngine, type SiliconFlowAsrConfig } from './asr-engine'
import type { TtsEngine, TtsEvents } from './tts-engine'
import { BrowserTtsEngine } from './tts-engine'

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
  readonly listeningAvailable: boolean
  readonly speakingAvailable: boolean
  readonly listening: boolean
  readonly speaking: boolean
  startListen(): void
  stopListen(): void
  cancelListen(): void
  speak(text: string): boolean
  stopSpeaking(): void
  destroy(): void
}

function siliconFlowUsable(): boolean {
  return typeof MediaRecorder !== 'undefined'
    && typeof navigator !== 'undefined'
    && Boolean(navigator.mediaDevices?.getUserMedia)
}

function createAsrEngine(events: AsrEvents, siliconFlow: SiliconFlowAsrConfig | undefined, bridge: TranscribeBridge): AsrEngine {
  if (siliconFlow?.available && siliconFlowUsable()) {
    return new SiliconFlowAsrEngine(siliconFlow, bridge, events)
  }
  return new WebSpeechAsrEngine(events)
}

export class BrowserVoiceEngine implements VoiceEngine {
  private asr: AsrEngine
  private tts: TtsEngine
  private destroyed = false
  private readonly events: Required<VoiceEngineEvents>

  constructor(
    events: VoiceEngineEvents = {},
    private readonly siliconFlow: SiliconFlowAsrConfig | undefined,
    private readonly bridge: TranscribeBridge,
    /** An externally built TTS engine (already wired to its own events). */
    externalTts?: TtsEngine
  ) {
    this.events = {
      onStateChange: events.onStateChange ?? (() => {}),
      onPartial: events.onPartial ?? (() => {}),
      onFinal: events.onFinal ?? (() => {}),
      onError: events.onError ?? (() => {}),
      onSpeakStart: events.onSpeakStart ?? (() => {}),
      onSpeakEnd: events.onSpeakEnd ?? (() => {})
    }

    this.asr = createAsrEngine(
      {
        onStateChange: (listening) => {
          if (this.destroyed) return
          this.events.onStateChange(listening ? 'listening' : this.tts.speaking ? 'speaking' : 'idle')
        },
        onPartial: (text) => {
          if (this.destroyed) return
          this.events.onPartial(text)
        },
        onFinal: (text) => {
          if (this.destroyed) return
          this.events.onFinal(text)
        },
        onError: (message) => {
          if (this.destroyed) return
          this.events.onError(message)
        }
      },
      this.siliconFlow,
      this.bridge
    )

    if (externalTts) {
      this.tts = externalTts
    } else {
      const ttsEvents: TtsEvents = {
        onSpeakStart: () => {
          if (this.destroyed) return
          this.events.onSpeakStart()
          this.events.onStateChange('speaking')
        },
        onSpeakEnd: () => {
          if (this.destroyed) return
          this.events.onSpeakEnd()
          this.events.onStateChange('idle')
        },
        onError: (message) => {
          if (this.destroyed) return
          this.events.onError(message)
        }
      }
      this.tts = new BrowserTtsEngine(ttsEvents)
    }
  }

  get available(): boolean {
    return this.listeningAvailable
  }

  get listeningAvailable(): boolean {
    return this.asr.available
  }

  get speakingAvailable(): boolean {
    return this.tts.available
  }

  get listening(): boolean {
    return this.asr.listening
  }

  get speaking(): boolean {
    return this.tts.speaking
  }

  startListen(): void {
    if (this.destroyed) return
    this.stopSpeaking()
    this.asr.start()
  }

  stopListen(): void {
    this.asr.stop()
  }

  cancelListen(): void {
    this.asr.cancel()
  }

  speak(text: string): boolean {
    if (this.destroyed || !text.trim()) return false
    this.asr.cancel()
    return this.tts.speak(text)
  }

  stopSpeaking(): void {
    this.tts.stopSpeaking()
  }

  destroy(): void {
    this.destroyed = true
    this.asr.destroy()
    this.tts.destroy()
  }
}

export { type SiliconFlowAsrConfig }
