import { describe, expect, it } from 'vitest'
import { getEnabledDeepSeekKey } from '../src/main/model-config'

describe('DeepSeek opt-in', () => {
  it('stays in demo mode when a key exists but the app is not enabled', () => {
    expect(getEnabledDeepSeekKey({ DEEPSEEK_API_KEY: 'secret' })).toBeUndefined()
    expect(getEnabledDeepSeekKey({ DESKTOP_PET_ENABLE_DEEPSEEK: '0', DEEPSEEK_API_KEY: 'secret' })).toBeUndefined()
  })

  it('requires both an explicit enable flag and a nonempty key', () => {
    expect(getEnabledDeepSeekKey({ DESKTOP_PET_ENABLE_DEEPSEEK: '1' })).toBeUndefined()
    expect(getEnabledDeepSeekKey({ DESKTOP_PET_ENABLE_DEEPSEEK: '1', DEEPSEEK_API_KEY: '  key  ' })).toBe('key')
  })
})
