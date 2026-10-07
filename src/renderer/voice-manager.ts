import type { AppSnapshot, PetAPI } from '../shared/contracts'
import { BrowserVoiceEngine, type VoiceEngine, type VoicePhase } from './voice-engine'

export type VoiceManagerPhase = VoicePhase | 'processing'

export interface VoiceManagerCallbacks {
  onPhaseChange?: (phase: VoiceManagerPhase) => void
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (message: string) => void
  onRequestText?: (text: string) => Promise<void>
}

export class VoiceManager {
  private readonly engine: VoiceEngine
  private phase: VoiceManagerPhase = 'idle'
  private pendingFinal = ''
  private speaking = false
  private destroyed = false

  constructor(
    private readonly bridge: PetAPI,
    private readonly callbacks: VoiceManagerCallbacks = {}
  ) {
    this.engine = new BrowserVoiceEngine({
      onStateChange: (enginePhase) => this.handleEnginePhase(enginePhase),
      onPartial: (text) => {
        this.pendingFinal = text
        this.callbacks.onPartial?.(text)
      },
      onFinal: (text) => {
        this.pendingFinal = ''
        this.callbacks.onFinal?.(text)
        void this.submit(text)
      },
      onError: (message) => {
        this.callbacks.onError?.(message)
        this.setPhase('idle')
      },
      onSpeakStart: () => {
        this.speaking = true
      },
      onSpeakEnd: () => {
        this.speaking = false
      },
    })
  }

  get available(): boolean {
    return this.engine.available
  }

  get currentPhase(): VoiceManagerPhase {
    return this.phase
  }

  start(): void {
    if (this.destroyed) return
    this.stop()
    this.setPhase('listening')
    this.engine.startListen()
  }

  stop(): void {
    if (this.destroyed) return
    this.engine.stopListen()
    this.engine.stopSpeaking()
    this.setPhase('idle')
  }

  speak(text: string): void {
    if (this.destroyed || !text.trim()) return
    this.engine.speak(text)
  }

  stopSpeaking(): void {
    this.engine.stopSpeaking()
  }

  updateFromSnapshot(snapshot: AppSnapshot): void {
    if (this.destroyed) return
    if (snapshot.taskStatus === 'done' && this.phase === 'processing') {
      const reply = this.extractAssistantReply(snapshot)
      if (reply) {
        this.speak(reply)
      } else {
        this.setPhase('idle')
      }
    }
    if (['failed', 'cancelled'].includes(snapshot.taskStatus) && this.phase === 'processing') {
      this.setPhase('idle')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.engine.destroy()
  }

  private handleEnginePhase(enginePhase: VoicePhase): void {
    if (enginePhase === 'listening') {
      this.setPhase('listening')
      return
    }
    if (enginePhase === 'speaking') {
      this.setPhase('speaking')
      return
    }
    if (this.phase === 'listening' || this.phase === 'speaking') {
      this.setPhase('idle')
    }
  }

  private async submit(text: string): Promise<void> {
    if (this.destroyed || !text.trim()) return
    this.setPhase('processing')
    try {
      await this.callbacks.onRequestText?.(text)
    } catch (error) {
      this.callbacks.onError?.(error instanceof Error ? error.message : '发送语音消息失败。')
      this.setPhase('idle')
    }
  }

  private setPhase(next: VoiceManagerPhase): void {
    if (this.phase === next) return
    this.phase = next
    this.syncAvatarState(next)
    this.callbacks.onPhaseChange?.(next)
  }

  private syncAvatarState(phase: VoiceManagerPhase): void {
    if (phase === 'listening') {
      void this.bridge.setAvatarState('listening').catch(() => undefined)
    } else if (phase === 'speaking') {
      void this.bridge.setAvatarState('speaking').catch(() => undefined)
    } else {
      void this.bridge.setAvatarState('idle').catch(() => undefined)
    }
  }

  private extractAssistantReply(snapshot: AppSnapshot): string | undefined {
    for (let i = snapshot.timeline.length - 1; i >= 0; i--) {
      const entry = snapshot.timeline[i]
      if (entry.kind === 'assistant') return entry.text
    }
    return undefined
  }
}
