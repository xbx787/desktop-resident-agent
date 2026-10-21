import { describe, expect, it } from 'vitest'
import { avatarEntryFrames, avatarEntryTiming, entryCueFor } from '../src/renderer/avatar-state-motion'

describe('avatar state entry motion', () => {
  it('lets interaction and voice interrupt a task cue without erasing the task lane', () => {
    expect(entryCueFor({ task: 'executing', voice: 'speaking', interaction: 'none', emotion: 'happy' })).toBe('speaking')
    expect(entryCueFor({ task: 'verifying', voice: 'listening', interaction: 'dragging', emotion: 'attentive' })).toBe('dragging')
    expect(entryCueFor({ task: 'planning', voice: 'silent', interaction: 'none', emotion: 'focused' })).toBe('planning')
  })

  it('keeps every one-shot inside the fixed visual budget and returns to neutral', () => {
    for (const cue of ['received', 'planning', 'executing', 'verifying', 'compacting', 'waiting', 'listening', 'speaking', 'completed', 'failed', 'cancelled'] as const) {
      const frames = avatarEntryFrames(cue, 1.2)
      expect(frames[0]?.transform).toContain('translate3d(0, 0, 0)')
      expect(frames.at(-1)?.transform).toContain('translate3d(0, 0, 0)')
      for (const frame of frames) {
        const values = String(frame.transform).match(/-?\d+(?:\.\d+)?px/g)?.map(Number.parseFloat) ?? []
        expect(values.every((value) => Math.abs(value) <= 4)).toBe(true)
      }
    }
  })

  it('gives completion more time than ordinary state acknowledgements', () => {
    expect(Number(avatarEntryTiming('completed').duration)).toBeGreaterThan(Number(avatarEntryTiming('planning').duration))
  })
})
