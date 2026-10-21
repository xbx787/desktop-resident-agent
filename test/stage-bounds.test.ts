import { describe, expect, it } from 'vitest'
import { AVATAR_STRIP, BUBBLE_BOTTOM, BUBBLE_MIN_HEIGHT, computeStageBounds, STAGE_HEIGHT, STAGE_WIDTH, TRIANGLE_ROOM } from '../src/main/stage-bounds'
import { PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH } from '../src/shared/contracts'

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

  it('keeps the avatar bottom anchored when it sits below the work edge', () => {
    // 头像窗口允许比工作区底多出一点（拖到任务栏边缘）；展开时不能因为
    // 舞台高度被压回工作区就把头像往上跳，舞台底边必须跟着头像底边。
    const below = { x: 200, y: 1000, width: 200, height: 220 }
    const next = computeStageBounds(below, work, true)
    expect(next.y + next.height).toBe(below.y + below.height)
    expect(next.y + next.height - below.height).toBe(below.y)
  })

  it('clamps the width to the work area', () => {
    const narrow = { x: 0, y: 0, width: 400, height: 700 }
    const next = computeStageBounds(resting, narrow, false)
    expect(next.width).toBe(400)
  })

  it('honours a user-chosen panel size on expanded, anchored bottom-right', () => {
    const next = computeStageBounds(resting, work, true, { width: 700, height: 500 })
    expect(next.width).toBe(700 + 20)               // 面板 + 左右各 10 的留白
    expect(next.height).toBe(500 + BUBBLE_BOTTOM)   // 面板 + 头像条与间距
    expect(next.x + next.width).toBe(resting.x + resting.width)
    expect(next.y + next.height).toBe(resting.y + resting.height)
  })

  it('lets a resized panel reach the work-area top when the avatar hangs below it', () => {
    // 头像拖到任务栏边缘后底边在工作区外；把面板往高处拖时，顶部仍要能
    // 一路顶到工作区顶——不能因为舞台高度被压回 work.height 就停在半路。
    const below = { x: 1800, y: 1000, width: 200, height: 220 } // 底边 1220，超出 108
    const next = computeStageBounds(below, work, true, { width: 484, height: 1112 })
    expect(next.y).toBe(work.y)
    expect(next.y + next.height).toBe(below.y + below.height)
    expect(next.height).toBe(below.y + below.height - work.y)
  })

  it('clamps a tiny saved size up to the usable minimum', () => {
    const next = computeStageBounds(resting, work, true, { width: 100, height: 100 })
    expect(next.width).toBe(PANEL_MIN_WIDTH + 20)
    expect(next.height).toBe(PANEL_MIN_HEIGHT + BUBBLE_BOTTOM)
  })
})

describe('computeStageBounds downward', () => {
  /** 人物在上半屏的中间偏左：底边 460，下面还有 652px。 */
  const high = { x: 800, y: 240, width: 200, height: 220 }

  it('collapsed hangs the stage from the avatar bottom edge', () => {
    const next = computeStageBounds(high, work, false, undefined, 'down')
    expect(next.y).toBe(high.y + high.height)
    expect(next.height).toBe(STAGE_HEIGHT)
    expect(next.x + next.width).toBe(high.x + high.width)
  })

  it('expanded fills the room below the avatar', () => {
    const next = computeStageBounds(high, work, true, undefined, 'down')
    expect(next.y).toBe(high.y + high.height)
    expect(next.height).toBe(work.y + work.height - (high.y + high.height))
  })

  it('honours a user-chosen panel size and keeps the top edge on the avatar', () => {
    const next = computeStageBounds(high, work, true, { width: 700, height: 500 }, 'down')
    expect(next.width).toBe(700 + 20)
    expect(next.height).toBe(500 + TRIANGLE_ROOM)
    expect(next.y).toBe(high.y + high.height)
    expect(next.x + next.width).toBe(high.x + high.width)
  })

  it('stops a big panel at the work-area bottom but keeps the usable minimum', () => {
    const next = computeStageBounds(high, work, true, { width: 500, height: 4000 }, 'down')
    expect(next.height).toBe(work.y + work.height - (high.y + high.height))
    const shortWork = { x: 0, y: 0, width: 1280, height: 700 }
    const nearBottom = { x: 300, y: 420, width: 200, height: 220 }
    const squeezed = computeStageBounds(nearBottom, shortWork, true, { width: 500, height: 4000 }, 'down')
    expect(squeezed.height).toBe(BUBBLE_MIN_HEIGHT + TRIANGLE_ROOM)
  })
})
