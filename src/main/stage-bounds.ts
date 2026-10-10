/** Geometry for the desktop stage — the transparent window the avatar and the
 *  bubble share. Collapsed, it is a fixed card around the avatar. Expanded, the
 *  bubble grows upward from the avatar's bottom edge towards the top of the
 *  work area; when the room above the bottom edge cannot fit a usable bubble,
 *  the whole stage slides down instead of squeezing the bubble flat. */

export interface StageRect {
  x: number
  y: number
  width: number
  height: number
}

/** Collapsed size of the shared window (avatar strip + folded bubble slot). */
export const STAGE_WIDTH = 554
export const STAGE_HEIGHT = 560

/** The strip at the window's bottom edge where the avatar itself lives. */
export const AVATAR_STRIP = 185

/** Smallest bubble area (window height minus the avatar strip) that still fits
 *  a header, the composer and a couple of message lines. */
export const BUBBLE_MIN_HEIGHT = 400

export function computeStageBounds(previous: StageRect, work: StageRect, expanded: boolean): StageRect {
  const width = Math.min(work.width, STAGE_WIDTH)
  const right = previous.x + previous.width
  const bottom = previous.y + previous.height
  const x = Math.max(work.x, Math.min(right - width, work.x + work.width - width))
  if (!expanded) return { x, y: bottom - STAGE_HEIGHT, width, height: STAGE_HEIGHT }
  const height = Math.min(work.height, Math.max(BUBBLE_MIN_HEIGHT + AVATAR_STRIP, bottom - work.y))
  // Prefer keeping the bottom edge (the avatar stays put) and reaching for the
  // top of the work area; if that would leave the bubble under the usable
  // minimum, or the stage hanging outside the work area, pull it back in.
  const y = Math.max(work.y, Math.min(bottom - height, work.y + work.height - height))
  return { x, y, width, height }
}
