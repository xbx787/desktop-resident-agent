import { describe, expect, it } from 'vitest'
import { FACE_HOLD_MS, lastUserEntryId, SEND_FACE_HOLD_MS, stateFace } from '../src/renderer/avatar-face'

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

describe('SEND_FACE_HOLD_MS', () => {
  it('keeps the "heard you" smile brief — the focus that follows is longer', () => {
    expect(SEND_FACE_HOLD_MS).toBeGreaterThanOrEqual(800)
    expect(SEND_FACE_HOLD_MS).toBeLessThanOrEqual(2500)
  })
})

describe('lastUserEntryId', () => {
  it('finds the newest user line and ignores everything else', () => {
    expect(lastUserEntryId([
      { id: 'a', kind: 'user' },
      { id: 'b', kind: 'assistant' },
      { id: 'c', kind: 'user' },
      { id: 'd', kind: 'tool' }
    ])).toBe('c')
  })

  it('returns null for timelines with no user message at all', () => {
    expect(lastUserEntryId([])).toBeNull()
    expect(lastUserEntryId([{ id: 'x', kind: 'system' }])).toBeNull()
  })
})
