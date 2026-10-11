import { describe, expect, it } from 'vitest'
import { AHOGE_ROOT, ahogeFlickFrames, ahogeOrigin } from '../src/renderer/avatar-ahoge'

describe('ahoge flick frames', () => {
  it('starts and ends at rest so the layer lands back on the body', () => {
    const frames = ahogeFlickFrames()
    expect(frames[0].transform).toBe('rotate(0deg)')
    expect(frames[frames.length - 1].transform).toBe('rotate(0deg)')
  })

  it('knocks the ahoge down first, overshoots up, then settles', () => {
    const degrees = ahogeFlickFrames().map((frame) => Number(/rotate\((-?[\d.]+)deg\)/.exec(String(frame.transform))?.[1]))
    expect(degrees).toEqual([0, -15, 9, -3.5, 0])
  })
})

describe('ahogeOrigin', () => {
  it('maps the traced root through a square box', () => {
    const origin = ahogeOrigin({ width: 400, height: 400 })
    expect(origin.x).toBeCloseTo(AHOGE_ROOT.x * 400, 5)
    expect(origin.y).toBeCloseTo(AHOGE_ROOT.y * 400, 5)
  })

  it('accounts for the contain letterbox in a wide box', () => {
    const origin = ahogeOrigin({ width: 600, height: 400 })
    expect(origin.x).toBeCloseTo(100 + AHOGE_ROOT.x * 400, 5)
    expect(origin.y).toBeCloseTo(AHOGE_ROOT.y * 400, 5)
  })
})
