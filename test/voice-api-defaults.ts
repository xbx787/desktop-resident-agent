import type { VoiceSettingsPublic } from '../src/shared/contracts'

export const defaultVoiceSettings: VoiceSettingsPublic = {
  keyConfigured: false,
  envKeyAvailable: false,
  needsKeyReentry: false,
  protectionUnavailable: false,
  loadError: false,
  voice: 'claire',
  speed: 1,
  autoSpeak: true,
  baseUrl: 'https://api.siliconflow.com',
  sttModel: 'FunAudioLLM/SenseVoiceSmall',
  ttsModel: 'FunAudioLLM/CosyVoice2-0.5B'
}

export const voiceApiDefaults = {
  voiceGet: async () => defaultVoiceSettings,
  voiceSave: async () => defaultVoiceSettings,
  voiceTest: async () => ({ ok: true, message: '' }),
  voicePickDocument: async () => null,
  voiceConvert: async () => ({ jobId: 'job-1', total: 1 }),
  voiceCancel: async () => undefined,
  voiceOpenOutput: async () => undefined,
  voiceOpenAudioRoot: async () => undefined,
  voiceOpenKeyPage: async () => undefined,
  onVoiceJobProgress: () => () => undefined
}
