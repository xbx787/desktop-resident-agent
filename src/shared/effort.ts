import type { EffortLevel } from './contracts'

/** Slider stops, shallow to deep. `off` is a real stop: DeepSeek's
 *  `thinking.type = disabled`, not just "a very small budget". */
export const EFFORT_LEVELS: readonly EffortLevel[] = ['off', 'low', 'high', 'max']

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  off: '关闭',
  low: '低',
  high: '高',
  max: '最大'
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value)
}

/** The fat track is 18 px tall, so its rounded ends are 9 px half-circles.
 *  That cap centre is where the outermost stop belongs — the end dot sits
 *  there, and the thumb's centre must be able to rest on the very same spot
 *  (the range input is inset accordingly in CSS). The middle stops divide
 *  the span between the two cap centres evenly. */
export const TRACK_END_INSET = 9

/** One stop's distance from the track's left edge, as CSS. Read by the tick
 *  dots and the fill alike; the thumb travels through the same positions. */
export function stopOffsetCss(index: number, count: number): string {
  const ratio = (index / (count - 1)).toFixed(4)
  return `calc(${TRACK_END_INSET}px + (100% - ${2 * TRACK_END_INSET}px) * ${ratio})`
}
