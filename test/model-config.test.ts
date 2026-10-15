import { describe, expect, it } from 'vitest'
import { getDeepSeekBalanceKey, getEnabledDeepSeekKey } from '../src/main/model-config'

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

describe('DeepSeek balance key', () => {
  const profile = (id: string, baseUrl: string, apiKey: string) => ({ id, name: id, baseUrl, apiKey, model: 'model' })

  it('uses the active DeepSeek profile before saved profiles and the launch environment', () => {
    const settings = {
      activeModelProfileId: 'second',
      modelProfiles: [
        profile('first', 'https://api.deepseek.com/anthropic', 'first-key'),
        profile('second', 'https://api.deepseek.com/anthropic/', 'second-key')
      ]
    }
    expect(getDeepSeekBalanceKey(settings, 'env-key')).toBe('second-key')
    settings.activeModelProfileId = 'first'
    expect(getDeepSeekBalanceKey(settings, 'env-key')).toBe('first-key')
  })

  it('uses another configured DeepSeek profile, then the launch key', () => {
    const settings = {
      activeModelProfileId: 'other',
      modelProfiles: [profile('other', 'https://api.moonshot.cn/anthropic', 'other-provider-key'),
        profile('deepseek', 'https://api.deepseek.com/anthropic', 'saved-key')]
    }
    expect(getDeepSeekBalanceKey(settings, 'env-key')).toBe('saved-key')
    settings.modelProfiles.pop()
    expect(getDeepSeekBalanceKey(settings, 'env-key')).toBe('env-key')
    expect(getDeepSeekBalanceKey(settings)).toBeUndefined()
  })

  it('never treats a lookalike host or invalid URL as an official account', () => {
    const settings = {
      activeModelProfileId: 'fake',
      modelProfiles: [profile('fake', 'https://api.deepseek.com.evil.test/anthropic', 'wrong-key'),
        profile('invalid', 'not a URL', 'invalid-key')]
    }
    expect(getDeepSeekBalanceKey(settings)).toBeUndefined()
  })
})
