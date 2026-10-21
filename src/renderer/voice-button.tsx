import type { CSSProperties } from 'react'
import type { VoiceManagerPhase } from './voice-manager'

const WAVE_BARS = 14

export function VoiceWaveform({ phase }: { phase: VoiceManagerPhase }) {
  const active = phase === 'listening' || phase === 'processing'
  if (!active) return null
  const processing = phase === 'processing'
  return <div className={`panel-voice-waveform${processing ? ' is-processing' : ''}`} role="status"
    aria-label={processing ? '正在转写' : '正在录音'}>
    {Array.from({ length: WAVE_BARS }, (_, index) =>
      <i key={index} style={{ '--bar': index } as CSSProperties} aria-hidden="true" />)}
  </div>
}

function MicrophoneIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3m-3 0h6" /></svg>
}

export function VoiceButton({ phase, canListen, disabled, onToggle }: {
  phase: VoiceManagerPhase
  canListen: boolean
  disabled?: boolean
  onToggle: () => void
}) {
  const listening = phase === 'listening'
  const processing = phase === 'processing'
  const speaking = phase === 'speaking'
  const label = listening ? '停止录音并转写'
    : processing ? '正在转写'
      : speaking ? '正在朗读，点击打断并说话'
        : canListen ? '开始语音输入' : '语音输入未配置，点击打开设置'
  return <button type="button"
    className={`panel-tool-button panel-microphone-button${listening ? ' is-listening' : ''}${speaking ? ' is-speaking' : ''}${processing ? ' is-processing' : ''}`}
    aria-label={label} aria-pressed={listening} disabled={disabled}
    onClick={onToggle}>
    {listening
      ? <span className="panel-voice-recording" aria-hidden="true"><i /></span>
      : processing
        ? <span className="panel-voice-spinner" aria-hidden="true" />
        : <MicrophoneIcon />}
  </button>
}
