import { describe, expect, it } from 'vitest'
import { clampSpeechSpeed, isSpeechSpeed, isVoicePresetId, siliconFlowVoiceName } from '../src/shared/voice'

describe('voice constants', () => {
  it('builds the complete voice name the API requires', () => {
    expect(siliconFlowVoiceName('claire')).toBe('FunAudioLLM/CosyVoice2-0.5B:claire')
    expect(siliconFlowVoiceName('unknown')).toBe('FunAudioLLM/CosyVoice2-0.5B:claire')
  })

  it('validates presets and speed', () => {
    expect(isVoicePresetId('anna')).toBe(true)
    expect(isVoicePresetId('nope')).toBe(false)
    expect(isSpeechSpeed(1)).toBe(true)
    expect(isSpeechSpeed(0.4)).toBe(false)
    expect(isSpeechSpeed(2.1)).toBe(false)
    expect(clampSpeechSpeed(9)).toBe(2)
    expect(clampSpeechSpeed(0.1)).toBe(0.5)
    expect(clampSpeechSpeed('bad')).toBe(1)
  })
})
