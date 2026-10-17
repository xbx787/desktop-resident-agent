/** Geometry for the desktop stage — the transparent window the avatar and the
 *  bubble share. Collapsed, it is a fixed card around the avatar. Expanded, the
 *  bubble grows upward from the avatar's bottom edge towards the top of the
 *  work area; when the room above the bottom edge cannot fit a usable bubble,
 *  the whole stage slides down instead of squeezing the bubble flat. */

import { PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH } from '../shared/contracts'

export interface StageRect {
  x: number
  y: number
  width: number
  height: number
}

/** Collapsed size of the shared window (avatar strip + folded bubble slot). */
export const STAGE_WIDTH = 554
export const STAGE_HEIGHT = 560

/** The strip at the window's bottom edge where the avatar itself lives.
 *  193 = the 128 px portrait + 12 px animation slack + the 53 px the bubble
 *  keeps clear of the character's hair. */
export const AVATAR_STRIP = 193

/** Smallest bubble area (window height minus the avatar strip) that still fits
 *  a header, the composer and a couple of message lines. */
export const BUBBLE_MIN_HEIGHT = 400

/** Vertical room the bubble leaves for the avatar strip below it. */
export const BUBBLE_BOTTOM = AVATAR_STRIP + 7

export interface PanelSize { width: number; height: number }

export function computeStageBounds(previous: StageRect, work: StageRect, expanded: boolean, panelSize?: PanelSize): StageRect {
  const right = previous.x + previous.width
  const bottom = previous.y + previous.height
  // 用户拖过尺寸：窗口 = 面板 + 左右 10px 留白，右缘与底缘保持不动（面板锚在
  // 右下）。没拖过时保持出厂行为：固定宽度、展开时向上顶到工作区顶端。
  if (expanded && panelSize) {
    const width = Math.min(work.width, Math.max(PANEL_MIN_WIDTH, panelSize.width) + 20)
    // 头像允许向下伸出工作区（脚贴任务栏）。舞台高度若压回 work.height，
    // 面板顶部就永远差那一段，拖缩放手柄也顶不到工作区顶。上限放到
    // bottom - work.y：顶部刚好停在 work.y，面板底仍咬着头像底边。
    const height = Math.min(
      Math.max(PANEL_MIN_HEIGHT, panelSize.height) + BUBBLE_BOTTOM,
      Math.max(BUBBLE_MIN_HEIGHT + BUBBLE_BOTTOM, bottom - work.y)
    )
    const x = Math.max(work.x, Math.min(right - width, work.x + work.width - width))
    const y = Math.max(work.y, Math.min(bottom - height, work.y + work.height - height))
    return { x, y, width, height }
  }
  const width = Math.min(work.width, STAGE_WIDTH)
  const x = Math.max(work.x, Math.min(right - width, work.x + work.width - width))
  if (!expanded) return { x, y: bottom - STAGE_HEIGHT, width, height: STAGE_HEIGHT }
  // 头像窗口贴着舞台底边；舞台底部允许跟着头像伸出工作区（人物可以拖到
  // 任务栏边缘），面板窗口自己按这个底边定位。这里不再把高度压回工作区，
  // 否则展开时头像会被迫上移。
  const height = Math.max(BUBBLE_MIN_HEIGHT + AVATAR_STRIP, bottom - work.y)
  // Prefer keeping the bottom edge (the avatar stays put) and reaching for the
  // top of the work area; if that would leave the bubble under the usable
  // minimum, or the stage hanging outside the work area, pull it back in.
  const y = Math.max(work.y, Math.min(bottom - height, work.y + work.height - height))
  return { x, y, width, height }
}
