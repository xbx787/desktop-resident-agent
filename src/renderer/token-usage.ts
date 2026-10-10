import type { TaskUsage } from '../shared/contracts'

/** 1_940_000 → "1.94M", 154_300 → "154.3K", 940 → "940". */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(Math.max(0, Math.round(value)))
}

/**
 * One line per billing bucket, for the hover breakdown. Empty when the split is
 * unknown (the direct DeepSeek path reports a bare total): callers then keep the
 * plain tooltip instead.
 */
export function tokenBreakdownRows(usage: TaskUsage): string[] {
  if (usage.input === undefined) return []
  const rows = [`输入未命中 ${compactTokens(usage.input)}`]
  if (usage.cacheRead) rows.push(`缓存命中 ${compactTokens(usage.cacheRead)}`)
  if (usage.cacheCreate) rows.push(`缓存写入 ${compactTokens(usage.cacheCreate)}`)
  if (usage.output !== undefined) rows.push(`输出 ${compactTokens(usage.output)}`)
  return rows
}
