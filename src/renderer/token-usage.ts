import type { TaskUsage } from '../shared/contracts'

/** 1_940_000 → "1.94M", 154_300 → "154.3K", 940 → "940". */
export function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(2))}M`
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`
  return String(Math.max(0, Math.round(value)))
}

/** Which published rate bills a row: a cache hit, a cache miss (a write is
 *  billed as a miss — the token is being processed for the first time), or
 *  output. The hover bill turns this into the row's multiplier. */
export type TokenBucket = 'miss' | 'hit' | 'output'

export interface TokenBreakdownRow {
  label: string
  amount: string
  /** Raw token count, so the hover bill can price the row itself. */
  tokens: number
  bucket: TokenBucket
}

/**
 * One row per billing bucket, for the hover breakdown. Empty when the split is
 * unknown (the direct DeepSeek path reports a bare total): callers then keep the
 * plain tooltip instead.
 */
export function tokenBreakdownRows(usage: TaskUsage): TokenBreakdownRow[] {
  if (usage.input === undefined) return []
  const rows: TokenBreakdownRow[] = [{ label: '输入未命中', amount: compactTokens(usage.input), tokens: usage.input, bucket: 'miss' }]
  if (usage.cacheRead) rows.push({ label: '输入命中', amount: compactTokens(usage.cacheRead), tokens: usage.cacheRead, bucket: 'hit' })
  if (usage.cacheCreate) rows.push({ label: '缓存写入', amount: compactTokens(usage.cacheCreate), tokens: usage.cacheCreate, bucket: 'miss' })
  if (usage.output !== undefined) rows.push({ label: '输出', amount: compactTokens(usage.output), tokens: usage.output, bucket: 'output' })
  return rows
}
