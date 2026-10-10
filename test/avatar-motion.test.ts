import { describe, expect, it } from 'vitest'
import { clickBounceFrames, clickBounceTiming, playClickBounce } from '../src/renderer/avatar-motion'

/** Geometry the frames must respect: the art draws a 160×160 square centred in
 *  the 160×180 hit target (src/renderer/avatar.css), and the window shape
 *  (avatarRegion in src/main/index.ts) is exactly that 160×180 — below/above
 *  10 px nothing is shown, and there is no horizontal slack at all. If any of
 *  those three constants change, revisit this file's numbers with the code. */
const TOP = 10
const BOTTOM = 170
const HALF = 80

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

  it('keeps every frame inside the window shape with a 2 px safety margin', () => {
    for (const frame of clickBounceFrames()) {
      const { ty, sy } = parseFrame(String(frame.transform))
      const grow = HALF * Math.abs(sy - 1)
      expect(TOP + ty - grow).toBeGreaterThanOrEqual(2)
      expect(BOTTOM + ty + grow).toBeLessThanOrEqual(178)
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
