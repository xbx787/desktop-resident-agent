import { describe, expect, it } from 'vitest'
import { idleFidgetFrames, idleFidgetTiming, nextFidgetDelay, startIdleFidgets } from '../src/renderer/avatar-idle'

/** Same geometry as the click bounce: the trimmed artwork is 139.5 px tall
 *  inside a hit box with 6 px of animation room above and below. */
const TOP = 6
const BOTTOM = 145.5
const HALF = 69.75
const BOX_BOTTOM = 151.5
const SLACK = 2

function parseFrame(transform: string): { ty: number; sy: number } {
  const ty = /translateY\((-?[\d.]+)px\)/.exec(transform)
  const sy = /scaleY\(([\d.]+)\)/.exec(transform)
  if (!ty || !sy) throw new Error(`unexpected transform: ${transform}`)
  return { ty: Number(ty[1]), sy: Number(sy[1]) }
}

describe('idle fidget frames', () => {
  it('uses only translateY and scaleY and stays inside the window shape with a 2 px safety margin', () => {
    for (const frame of idleFidgetFrames()) {
      const transform = String(frame.transform)
      const rest = transform.replace(/translateY\([^)]*\)|scaleY\([^)]*\)/g, '').trim()
      expect(rest).toBe('')
      const { ty, sy } = parseFrame(transform)
      const grow = HALF * Math.abs(sy - 1)
      expect(TOP + ty - grow).toBeGreaterThanOrEqual(-SLACK)
      expect(BOTTOM + ty + grow).toBeLessThanOrEqual(BOX_BOTTOM + SLACK)
    }
  })

  it('starts and ends at rest, and stays short and once-only', () => {
    const frames = idleFidgetFrames()
    expect(parseFrame(String(frames[0].transform))).toEqual({ ty: 0, sy: 1 })
    expect(parseFrame(String(frames[frames.length - 1].transform))).toEqual({ ty: 0, sy: 1 })
    const timing = idleFidgetTiming()
    expect(timing.duration).toBeGreaterThan(0)
    expect(timing.duration).toBeLessThanOrEqual(900)
    expect(timing.fill).toBeUndefined()
  })
})

describe('nextFidgetDelay', () => {
  it('lands between 18 and 45 seconds so the fidget reads as life, not a loop', () => {
    expect(nextFidgetDelay(() => 0)).toBe(18000)
    expect(nextFidgetDelay(() => 1)).toBe(45000)
    expect(nextFidgetDelay(() => 0.5)).toBe(31500)
  })
})

describe('startIdleFidgets guards', () => {
  it('returns a no-op without an element or under reduced motion, and never animates then', () => {
    expect(typeof startIdleFidgets(null)).toBe('function')
    let called = false
    const fake = { animate: () => { called = true; return { cancel() {} } as unknown as Animation } } as unknown as Element
    const stop = startIdleFidgets(fake, true)
    stop()
    expect(called).toBe(false)
  })
})
