import { describe, expect, it } from 'vitest'
import { AVATAR_STRIP, BUBBLE_MIN_HEIGHT, computeStageBounds, STAGE_HEIGHT, STAGE_WIDTH } from '../src/main/stage-bounds'

/** A 2048×1112 DIP work area (2560×1440 at 125%), the shape of the machine
 *  this shipped on. */
const work = { x: 0, y: 0, width: 2048, height: 1112 }
/** The default resting spot: bottom-right, 24 px of air. */
const resting = { x: 2048 - STAGE_WIDTH - 24, y: 1112 - STAGE_HEIGHT - 24, width: STAGE_WIDTH, height: STAGE_HEIGHT }

describe('computeStageBounds', () => {
  it('collapsed keeps the card size and the bottom edge', () => {
    const next = computeStageBounds(resting, work, false)
    expect(next).toEqual(resting)
  })

  it('expanded grows up to the work-area top when there is room', () => {
    const next = computeStageBounds(resting, work, true)
    expect(next.y).toBe(work.y)
    expect(next.height).toBe(resting.y + resting.height - work.y)
  })

  it('keeps a usable bubble by sliding down when the window sits near the top', () => {
    // Dragged to the very top: the bottom edge is only 90 px from the work top,
    // which under the old formula squeezed the bubble to a sliver.
    const high = { x: 200, y: 90 - STAGE_HEIGHT, width: STAGE_WIDTH, height: STAGE_HEIGHT }
    const next = computeStageBounds(high, work, true)
    expect(next.y).toBe(work.y)
    expect(next.height).toBe(BUBBLE_MIN_HEIGHT + AVATAR_STRIP)
    expect(next.height - AVATAR_STRIP).toBeGreaterThanOrEqual(BUBBLE_MIN_HEIGHT)
  })

  it('never pushes the stage out of a short work area', () => {
    const short = { x: 0, y: 0, width: 1280, height: 700 }
    const start = { x: 300, y: 140, width: STAGE_WIDTH, height: STAGE_HEIGHT }
    const next = computeStageBounds(start, short, true)
    expect(next.height).toBeLessThanOrEqual(short.height)
    expect(next.y).toBeGreaterThanOrEqual(short.y)
    expect(next.y + next.height).toBeLessThanOrEqual(short.y + short.height)
  })

  it('pulls the stage back up when it hangs below the work area', () => {
    const below = { x: 200, y: 1000, width: STAGE_WIDTH, height: STAGE_HEIGHT }
    const next = computeStageBounds(below, work, true)
    expect(next.y + next.height).toBeLessThanOrEqual(work.y + work.height)
  })

  it('clamps the width to the work area', () => {
    const narrow = { x: 0, y: 0, width: 400, height: 700 }
    const next = computeStageBounds(resting, narrow, false)
    expect(next.width).toBe(400)
  })
})
