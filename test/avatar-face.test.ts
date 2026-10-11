import { describe, expect, it } from 'vitest'
import { FACE_HOLD_MS, stateFace } from '../src/renderer/avatar-face'

describe('stateFace', () => {
  it('maps a busy turn to focus and a delivered reply to smile', () => {
    expect(stateFace('thinking')).toBe('focus')
    expect(stateFace('acting')).toBe('focus')
    expect(stateFace('success')).toBe('smile')
  })

  it('leaves every other state faceless', () => {
    for (const state of ['idle', 'listening', 'speaking', 'error', undefined, '']) {
      expect(stateFace(state)).toBeNull()
    }
  })
})

describe('FACE_HOLD_MS', () => {
  it('keeps the finished smile long enough to register, short enough not to linger', () => {
    expect(FACE_HOLD_MS).toBeGreaterThanOrEqual(3000)
    expect(FACE_HOLD_MS).toBeLessThanOrEqual(6000)
  })
})
