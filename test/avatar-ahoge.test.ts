import { describe, expect, it } from 'vitest'
import { AHOGE_CANVAS, AHOGE_ROOT, ahogeFlickFrames, ahogeOrigin } from '../src/renderer/avatar-ahoge'

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
  it('uses the root on the actual 1016×1218 cropped canvas', () => {
    expect(AHOGE_CANVAS).toEqual({ width: 1016, height: 1218 })
    expect(AHOGE_ROOT).toEqual({ x: 502 / 1016, y: 88 / 1218 })
    const origin = ahogeOrigin(AHOGE_CANVAS)
    expect(origin.x).toBeCloseTo(502, 5)
    expect(origin.y).toBeCloseTo(88, 5)
  })

  it('accounts for contain letterboxing without treating the art as square', () => {
    const origin = ahogeOrigin({ width: 600, height: 400 })
    const scale = 400 / AHOGE_CANVAS.height
    expect(origin.x).toBeCloseTo((600 - AHOGE_CANVAS.width * scale) / 2 + 502 * scale, 5)
    expect(origin.y).toBeCloseTo(88 * scale, 5)
  })
})
