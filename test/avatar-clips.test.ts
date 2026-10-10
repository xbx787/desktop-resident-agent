import { describe, expect, it } from 'vitest'
import { CLICK_CLIP, CLIPS, nextFrame } from '../src/renderer/avatar-clips'

describe('nextFrame', () => {
  it('wraps in loop mode and ends a once-clip on its last frame', () => {
    expect(nextFrame(0, 4, 'loop')).toBe(1)
    expect(nextFrame(2, 4, 'loop')).toBe(3)
    expect(nextFrame(3, 4, 'loop')).toBe(0)
    expect(nextFrame(0, 1, 'loop')).toBe(0)
    expect(nextFrame(1, 4, 'once')).toBe(2)
    expect(nextFrame(3, 4, 'once')).toBeNull()
    expect(nextFrame(0, 1, 'once')).toBeNull()
    expect(nextFrame(0, 0, 'loop')).toBeNull()
  })
})

describe('clip library', () => {
  it('ships the ear-flick batch: four frames, ten fps, played once', () => {
    expect(CLICK_CLIP).toBe('ear-flick')
    const flick = CLIPS[CLICK_CLIP]
    expect(flick.frames).toHaveLength(4)
    expect(flick.fps).toBe(10)
    expect(flick.loop).toBe('once')
    flick.frames.forEach((frame, index) => {
      expect(frame).toMatch(new RegExp(`clips/ear-flick/0${index + 1}\\.png$`))
    })
  })
})
