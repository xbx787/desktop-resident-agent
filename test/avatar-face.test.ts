import { describe, expect, it } from 'vitest'
import { FACE_HOLD_MS, isFreshUserEntry, lastUserEntryId, resolveAvatarPresentation, SEND_FACE_HOLD_MS, stateFace, taskDot } from '../src/renderer/avatar-face'

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

describe('resolved avatar presentation', () => {
  it('keeps the task, voice and approval states in a stable priority order', () => {
    expect(resolveAvatarPresentation({ taskStatus: 'planning', avatarState: 'thinking' }))
      .toEqual({ activity: 'working', face: 'focus', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'awaiting_approval', avatarState: 'thinking' }))
      .toEqual({ activity: 'waiting', face: 'question', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'executing', avatarState: 'speaking' }))
      .toEqual({ activity: 'speaking', face: 'smile', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'executing', acknowledging: true }))
      .toEqual({ activity: 'working', face: 'smile', idleAllowed: false })
  })

  it('freezes idle during drag and active tasks, then returns to idle cleanly', () => {
    expect(resolveAvatarPresentation({ dragging: true, taskStatus: 'executing' }))
      .toEqual({ activity: 'dragging', face: 'focus', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'done', settled: 'done' }))
      .toEqual({ activity: 'completed', face: 'smile', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'failed', settled: 'failed' }))
      .toEqual({ activity: 'failed', face: 'failed', idleAllowed: false })
    expect(resolveAvatarPresentation({ taskStatus: 'done' }))
      .toEqual({ activity: 'idle', face: null, idleAllowed: true })
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

describe('isFreshUserEntry', () => {
  it('recognises a new entry in the current conversation during the same render', () => {
    expect(isFreshUserEntry({ conversationId: 'a', entryId: 'u1' }, 'a', 'u2')).toBe(true)
    expect(isFreshUserEntry({ conversationId: 'a', entryId: 'u1' }, 'a', 'u1')).toBe(false)
  })

  it('re-anchors silently on first load and conversation switches', () => {
    expect(isFreshUserEntry(null, 'a', 'u1')).toBe(false)
    expect(isFreshUserEntry({ conversationId: 'a', entryId: 'u1' }, 'b', 'u2')).toBe(false)
    expect(isFreshUserEntry({ conversationId: 'a', entryId: 'u1' }, 'a', null)).toBe(false)
  })
})

describe('taskDot', () => {
  it('rides busy statuses with a pulsing amber dot', () => {
    for (const state of ['planning', 'executing', 'verifying']) {
      expect(taskDot(state)).toEqual({ tone: 'busy', pulse: true })
    }
  })

  it('marks a waiting decision blue and settled outcomes green/red', () => {
    expect(taskDot('awaiting_approval')).toEqual({ tone: 'waiting', pulse: true })
    expect(taskDot('done')).toEqual({ tone: 'done', pulse: false })
    expect(taskDot('failed')).toEqual({ tone: 'failed', pulse: false })
  })

  it('shows nothing for idle, cancelled or unknown states', () => {
    for (const state of ['idle', 'cancelled', undefined, '']) {
      expect(taskDot(state)).toBeNull()
    }
  })
})
