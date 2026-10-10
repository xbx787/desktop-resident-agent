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
