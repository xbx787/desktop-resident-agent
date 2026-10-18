import type { AppSnapshot, PetAPI, VoiceConfig } from '../shared/contracts'
import { DEFAULT_SPEECH_SPEED, DEFAULT_VOICE } from '../shared/voice'
import { BrowserVoiceEngine, type VoiceEngine, type VoicePhase, type SiliconFlowAsrConfig } from './voice-engine'
import { BrowserTtsEngine } from './tts-engine'
import { SiliconFlowTtsEngine } from './siliconflow-tts-engine'

export type VoiceManagerPhase = VoicePhase | 'processing'

export interface VoiceManagerCallbacks {
  onPhaseChange?: (phase: VoiceManagerPhase) => void
  onPartial?: (text: string) => void
  onFinal?: (text: string) => void
  onError?: (message: string) => void
  onRequestText?: (text: string) => Promise<void>
}

const REPLY_TIMEOUT_MS = 15 * 60_000

function toSiliconFlowConfig(config: VoiceConfig): SiliconFlowAsrConfig | undefined {
  if (!config.siliconFlowAvailable) return undefined
  return {
    available: true,
    model: config.siliconFlowModel,
    baseUrl: config.siliconFlowBaseUrl
  }
}

function normalized(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

export class VoiceManager {
  private engine: VoiceEngine
  private phase: VoiceManagerPhase = 'idle'
  private destroyed = false
  private autoSpeak = true
  private pendingVoiceText = ''
  private replyBaselineRevision = -1
  private lastRevision = 0
  private replyTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly bridge: PetAPI,
    private readonly callbacks: VoiceManagerCallbacks = {},
    voiceConfig?: VoiceConfig
  ) {
    this.autoSpeak = voiceConfig?.autoSpeak !== false
    this.engine = this.createEngine(voiceConfig)
  }

  get available(): boolean {
    return this.engine.listeningAvailable
  }

  get canSpeak(): boolean {
    return this.engine.speakingAvailable
  }

  get currentPhase(): VoiceManagerPhase {
    return this.phase
  }

  start(): void {
    if (this.destroyed) return
    this.engine.stopSpeaking()
    this.pendingVoiceText = ''
    this.setPhase('listening')
    this.engine.startListen()
  }

  /** Stops recording and lets the ASR engine transcribe. */
  stop(): void {
    if (this.destroyed) return
    this.engine.stopListen()
    this.setPhase('idle')
  }

  /** Drops the recording (or the pending reply) without sending anything. */
  cancel(): void {
    if (this.destroyed) return
    this.engine.cancelListen()
    this.engine.stopSpeaking()
    this.pendingVoiceText = ''
    this.setPhase('idle')
  }

  toggle(): void {
    if (this.destroyed) return
    if (this.phase === 'listening') { this.stop(); return }
    if (this.phase === 'speaking') { this.engine.stopSpeaking(); this.start(); return }
    if (this.phase === 'processing') { this.cancel(); return }
    this.start()
  }

  speak(text: string): void {
    if (this.destroyed || !text.trim()) return
    if (!this.engine.speak(text)) this.setPhase('idle')
  }

  stopSpeaking(): void {
    this.engine.stopSpeaking()
  }

  /** Rebuilds the engine after settings change; a running recording is dropped. */
  updateConfig(config: VoiceConfig): void {
    if (this.destroyed) return
    this.autoSpeak = config.autoSpeak !== false
    this.engine.destroy()
    this.engine = this.createEngine(config)
    if (this.phase !== 'idle') this.setPhase('idle')
  }

  updateFromSnapshot(snapshot: AppSnapshot): void {
    if (this.destroyed) return
    this.lastRevision = Math.max(this.lastRevision, snapshot.timelineRevision)
    if (snapshot.taskStatus === 'done' && this.phase === 'processing') {
      if (snapshot.timelineRevision <= this.replyBaselineRevision) return
      if (!this.matchesPendingVoiceTurn(snapshot)) return
      const reply = this.extractAssistantReply(snapshot)
      this.pendingVoiceText = ''
      if (!this.autoSpeak || !reply || !this.engine.speak(reply)) {
        this.setPhase('idle')
      }
      return
    }
    if (['failed', 'cancelled'].includes(snapshot.taskStatus) && this.phase === 'processing') {
      this.pendingVoiceText = ''
      this.setPhase('idle')
    }
  }

  destroy(): void {
    this.destroyed = true
    this.clearReplyTimer()
    this.engine.destroy()
  }

  private createEngine(config: VoiceConfig | undefined): VoiceEngine {
    const tts = config?.ttsAvailable
      ? new SiliconFlowTtsEngine(
        { voice: config.voice ?? DEFAULT_VOICE, speed: config.speed ?? DEFAULT_SPEECH_SPEED },
        this.bridge,
        {
          onSpeakStart: () => this.handleSpeakStart(),
          onSpeakEnd: () => this.handleSpeakEnd(),
          onError: (message) => this.handleSpeakError(message)
        },
        new BrowserTtsEngine()
      )
      : undefined
    return new BrowserVoiceEngine({
      onStateChange: (enginePhase) => this.handleEnginePhase(enginePhase),
      onPartial: (text) => this.callbacks.onPartial?.(text),
      onFinal: (text) => {
        this.callbacks.onFinal?.(text)
        void this.submit(text)
      },
      onError: (message) => {
        this.callbacks.onError?.(message)
        this.setPhase('idle')
      },
      onSpeakStart: () => this.handleSpeakStart(),
      onSpeakEnd: () => this.handleSpeakEnd()
    }, config ? toSiliconFlowConfig(config) : undefined, this.bridge, tts)
  }

  private handleSpeakStart(): void {
    this.setPhase('speaking')
  }

  private handleSpeakEnd(): void {
    if (this.phase === 'speaking') this.setPhase('idle')
  }

  private handleSpeakError(message: string): void {
    this.callbacks.onError?.(message)
    if (this.phase === 'speaking') this.setPhase('idle')
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
    if (this.phase === 'listening' || this.phase === 'speaking') this.setPhase('idle')
  }

  private async submit(text: string): Promise<void> {
    if (this.destroyed || !text.trim()) return
    this.pendingVoiceText = normalized(text)
    this.replyBaselineRevision = this.lastRevision
    this.setPhase('processing')
    try {
      await this.callbacks.onRequestText?.(text)
    } catch (error) {
      this.pendingVoiceText = ''
      this.callbacks.onError?.(error instanceof Error ? error.message : '发送语音消息失败。')
      this.setPhase('idle')
    }
  }

  private matchesPendingVoiceTurn(snapshot: AppSnapshot): boolean {
    if (!this.pendingVoiceText) return false
    for (let index = snapshot.timeline.length - 1; index >= 0; index -= 1) {
      const entry = snapshot.timeline[index]
      if (entry.kind !== 'user') continue
      return normalized(entry.text) === this.pendingVoiceText
    }
    return false
  }

  private extractAssistantReply(snapshot: AppSnapshot): string | undefined {
    for (let index = snapshot.timeline.length - 1; index >= 0; index -= 1) {
      const entry = snapshot.timeline[index]
      if (entry.kind === 'assistant' && entry.text.trim()) return entry.text
    }
    return undefined
  }

  private setPhase(next: VoiceManagerPhase): void {
    if (this.phase === next) return
    this.phase = next
    if (next === 'processing') this.startReplyTimer()
    else this.clearReplyTimer()
    this.syncAvatarState(next)
    this.callbacks.onPhaseChange?.(next)
  }

  private startReplyTimer(): void {
    this.clearReplyTimer()
    this.replyTimer = setTimeout(() => {
      this.pendingVoiceText = ''
      this.setPhase('idle')
    }, REPLY_TIMEOUT_MS)
  }

  private clearReplyTimer(): void {
    if (this.replyTimer !== undefined) {
      clearTimeout(this.replyTimer)
      this.replyTimer = undefined
    }
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
}
