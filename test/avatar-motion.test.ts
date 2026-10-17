import { describe, expect, it } from 'vitest'
import { clickBounceFrames, clickBounceTiming, playClickBounce } from '../src/renderer/avatar-motion'

/** Geometry the frames must respect: the trimmed artwork is 128 px tall and
 *  sits in a hit box with 6 px of animation room above and below (height
 *  140). The window shape is that box, so a frame may poke past it by at
 *  most the 2 px safety margin below. If the box constants change, revisit
 *  this file's numbers with the code. */
const TOP = 6
const BOTTOM = 134
const HALF = 64
const BOX_BOTTOM = 140
const SLACK = 2

function parseFrame(transform: string): { ty: number; sy: number } {
  const ty = /translateY\((-?[\d.]+)px\)/.exec(transform)
  const sy = /scaleY\(([\d.]+)\)/.exec(transform)
  if (!ty || !sy) throw new Error(`unexpected transform: ${transform}`)
  return { ty: Number(ty[1]), sy: Number(sy[1]) }
}

describe('click bounce frames', () => {
  it('uses only translateY and scaleY — no horizontal motion, no combined scale', () => {
    for (const frame of clickBounceFrames()) {
      const rest = String(frame.transform).replace(/translateY\([^)]*\)|scaleY\([^)]*\)/g, '').trim()
      expect(rest).toBe('')
    }
  })

  it('keeps every frame inside the window shape within a 2 px safety margin', () => {
    for (const frame of clickBounceFrames()) {
      const { ty, sy } = parseFrame(String(frame.transform))
      const grow = HALF * Math.abs(sy - 1)
      expect(TOP + ty - grow).toBeGreaterThanOrEqual(-SLACK)
      expect(BOTTOM + ty + grow).toBeLessThanOrEqual(BOX_BOTTOM + SLACK)
    }
  })

  it('starts at rest and ends at rest so the button returns exactly to layout', () => {
    const frames = clickBounceFrames()
    expect(parseFrame(String(frames[0].transform))).toEqual({ ty: 4.5, sy: 0.96 })
    const last = parseFrame(String(frames[frames.length - 1].transform))
    expect(last).toEqual({ ty: 0, sy: 1 })
  })

  it('keeps the bounce short and once-only (no fill, compositor-friendly options)', () => {
    const timing = clickBounceTiming()
    expect(timing.duration).toBeGreaterThan(0)
    expect(timing.duration).toBeLessThanOrEqual(400)
    expect(timing.fill).toBeUndefined()
  })
})

describe('playClickBounce guards', () => {
  it('returns null without an element or when motion is reduced, and never animates then', () => {
    expect(playClickBounce(null)).toBeNull()
    let called = false
    const fake = { animate: () => { called = true; return { cancel() {} } as unknown as Animation } } as unknown as Element
    expect(playClickBounce(fake, true)).toBeNull()
    expect(called).toBe(false)
  })

  it('starts the animation with the shared frames when allowed', () => {
    let received = 0
    let cancelled = 0
    const fake = {
      animate: (frames: Keyframe[]) => {
        received = frames.length
        return { cancel() { cancelled += 1 } } as unknown as Animation
      }
    } as unknown as Element
    const animation = playClickBounce(fake, false)
    expect(animation).not.toBeNull()
    expect(received).toBe(clickBounceFrames().length)
    // A second poke cancels the previous pass before starting over.
    playClickBounce(fake, false)
    expect(cancelled).toBe(1)
  })
})
