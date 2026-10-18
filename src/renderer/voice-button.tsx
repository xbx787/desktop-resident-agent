import type { VoiceManagerPhase } from './voice-manager'

function MicrophoneIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3" /><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3m-3 0h6" /></svg>
}

function Wave({ top }: { top?: boolean }) {
  return <span className={`panel-voice-wave-bars${top ? ' is-top' : ' is-bottom'}`} aria-hidden="true">
    <i /><i /><i />
  </span>
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
    : processing ? '正在等待回复，点击取消'
      : speaking ? '正在朗读，点击打断并说话'
        : canListen ? '开始语音输入' : '语音输入未配置，点击打开设置'
  return <button type="button"
    className={`panel-tool-button panel-microphone-button${listening ? ' is-listening' : ''}${speaking ? ' is-speaking' : ''}${processing ? ' is-processing' : ''}`}
    aria-label={label} aria-pressed={listening} disabled={disabled}
    onClick={onToggle}>
    {listening
      ? <span className="panel-voice-wave" aria-hidden="true">
          <Wave top />
          <span className="panel-voice-stop" />
          <Wave />
        </span>
      : processing
        ? <span className="panel-voice-spinner" aria-hidden="true" />
        : <MicrophoneIcon />}
  </button>
}
