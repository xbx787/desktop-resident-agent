/** Shared voice constants. The renderer never sees an API key; these are only
 *  models, voices, and bounds used by both processes. */

export const DEFAULT_SILICONFLOW_BASE_URL = 'https://api.siliconflow.com'
export const SILICONFLOW_KEY_PAGES = [
  'https://cloud.siliconflow.cn/account/ak',
  'https://cloud.siliconflow.com/account/ak'
] as const

export const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall'
export const TTS_MODEL = 'FunAudioLLM/CosyVoice2-0.5B'

export interface VoicePreset {
  id: string
  label: string
}

export const VOICE_PRESETS: readonly VoicePreset[] = [
  { id: 'claire', label: '温柔女声' },
  { id: 'anna', label: '沉稳女声' },
  { id: 'bella', label: '激情女声' },
  { id: 'diana', label: '欢快女声' },
  { id: 'alex', label: '沉稳男声' },
  { id: 'benjamin', label: '低沉男声' },
  { id: 'charles', label: '磁性男声' },
  { id: 'david', label: '欢快男声' }
]

export type VoicePresetId = string

export const DEFAULT_VOICE: VoicePresetId = 'claire'
export const DEFAULT_SPEECH_SPEED = 1
export const SPEECH_SPEED_MIN = 0.5
export const SPEECH_SPEED_MAX = 2

export const MAX_TTS_INPUT_CHARS = 300
export const MAX_REPLY_SPEECH_CHARS = 12_000
export const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
export const MAX_DOCUMENT_SEGMENTS = 1_000

export function isVoicePresetId(value: unknown): value is VoicePresetId {
  return typeof value === 'string' && VOICE_PRESETS.some((preset) => preset.id === value)
}

export function isSpeechSpeed(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) &&
    value >= SPEECH_SPEED_MIN && value <= SPEECH_SPEED_MAX
}

/** SiliconFlow wants the model prefix in the voice field. */
export function siliconFlowVoiceName(id: VoicePresetId): string {
  return `${TTS_MODEL}:${isVoicePresetId(id) ? id : DEFAULT_VOICE}`
}

export function clampSpeechSpeed(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return DEFAULT_SPEECH_SPEED
  return Math.min(SPEECH_SPEED_MAX, Math.max(SPEECH_SPEED_MIN, Math.round(parsed * 100) / 100))
}
