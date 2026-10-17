import { describe, expect, it } from 'vitest'
import { canAdvance, nextStep, ONBOARDING_STEPS, previousStep, stepIndex } from '../src/renderer/onboarding-flow'
import { shouldOfferOnboarding } from '../src/main/onboarding'
import { apiKeyHint, normalizeApiKey } from '../src/shared/onboarding'

describe('onboarding flow', () => {
  it('walks forward and back through the steps and stops at the ends', () => {
    expect(ONBOARDING_STEPS).toHaveLength(5)
    expect(nextStep('welcome')).toBe('register')
    expect(nextStep('register')).toBe('key')
    expect(nextStep('key')).toBe('workspace')
    expect(nextStep('workspace')).toBe('test')
    expect(nextStep('test')).toBeNull()
    expect(previousStep('welcome')).toBeNull()
    expect(previousStep('test')).toBe('workspace')
    expect(stepIndex('workspace')).toBe(3)
  })

  it('blocks leaving the key or workspace step empty but allows the rest', () => {
    expect(canAdvance('welcome', '')).toBe(true)
    expect(canAdvance('key', '   ')).toBe(false)
    expect(canAdvance('key', 'sk-x')).toBe(true)
    expect(canAdvance('workspace', 'sk-x', '')).toBe(false)
    expect(canAdvance('workspace', 'sk-x', '  ')).toBe(false)
    expect(canAdvance('workspace', 'sk-x', 'D:\\project')).toBe(true)
    expect(canAdvance('test', '')).toBe(true)
  })
})

describe('onboarding offers', () => {
  it('re-offers the wizard after a key could not be decrypted on this computer', () => {
    expect(shouldOfferOnboarding(null, 0, false)).toBe(true)
    expect(shouldOfferOnboarding({ version: 1, outcome: 'completed', at: '' }, 1, false)).toBe(false)
    expect(shouldOfferOnboarding({ version: 1, outcome: 'completed', at: '' }, 1, true)).toBe(true)
  })
})

describe('api key helpers', () => {
  it('normalizes stray whitespace, quotes and a Bearer prefix', () => {
    expect(normalizeApiKey('  sk-abc  ')).toBe('sk-abc')
    expect(normalizeApiKey('Bearer sk-abc')).toBe('sk-abc')
    expect(normalizeApiKey('"sk-abc"')).toBe('sk-abc')
    expect(normalizeApiKey('“sk-abc”')).toBe('sk-abc')
  })

  it('hints softly at the key shape without blocking', () => {
    expect(apiKeyHint('')).toBe('empty')
    expect(apiKeyHint('sk-abcdefgh12345678')).toBe('good')
    expect(apiKeyHint('hello')).toBe('suspicious')
  })
})
