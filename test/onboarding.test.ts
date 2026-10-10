import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  deepSeekProfile,
  ONBOARDING_PAGES,
  readOnboardingMarker,
  shouldOfferOnboarding,
  writeOnboardingMarker
} from '../src/main/onboarding'

function tempDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'whale-onboarding-'))
}

describe('onboarding marker', () => {
  it('round-trips outcomes and treats absence as not offered', () => {
    const dir = tempDir()
    try {
      expect(readOnboardingMarker(dir)).toBeNull()
      writeOnboardingMarker(dir, 'skipped')
      const marker = readOnboardingMarker(dir)
      expect(marker?.outcome).toBe('skipped')
      expect(marker?.version).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('treats a corrupt marker as not offered', () => {
    const dir = tempDir()
    try {
      writeFileSync(path.join(dir, 'onboarding.json'), '{oops', 'utf8')
      expect(readOnboardingMarker(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('shouldOfferOnboarding', () => {
  it('offers only with no marker and no configured profile', () => {
    expect(shouldOfferOnboarding(null, 0)).toBe(true)
    expect(shouldOfferOnboarding(null, 1)).toBe(false)
    expect(shouldOfferOnboarding({ version: 1, outcome: 'skipped', at: '' }, 0)).toBe(false)
    expect(shouldOfferOnboarding({ version: 1, outcome: 'completed', at: '' }, 0)).toBe(false)
  })
})

describe('deepSeekProfile', () => {
  it('builds from the shared catalog with the chosen model', () => {
    const profile = deepSeekProfile('sk-test-0123456789', 'deepseek-chat', 'fixed-id')
    expect(profile).toMatchObject({
      id: 'fixed-id',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      apiKey: 'sk-test-0123456789',
      model: 'deepseek-chat',
      smallModel: 'deepseek-flash'
    })
  })

  it('opens only pages from the fixed table', () => {
    expect(ONBOARDING_PAGES.signup).toBe('https://platform.deepseek.com/sign_up')
    expect(ONBOARDING_PAGES['api-keys']).toBe('https://platform.deepseek.com/api_keys')
    expect(ONBOARDING_PAGES['top-up']).toBe('https://platform.deepseek.com/top_up')
  })
})
