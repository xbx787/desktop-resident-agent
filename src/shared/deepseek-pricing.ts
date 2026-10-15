export type PriceTier = 'peak' | 'off_peak' | 'unknown'

export interface PeakStatus {
  tier: PriceTier
  nextChangeAt?: number
  nextTier?: Exclude<PriceTier, 'unknown'>
  holiday: boolean
}

// 2026 public holidays from the State Council schedule. Weekend make-up workdays
// remain off-peak because DeepSeek's pricing rule says all weekends are off-peak.
// https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
const HOLIDAYS_2026 = [
  ['2026-01-01', '2026-01-03'],
  ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'],
  ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'],
  ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07']
] as const

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

function beijingParts(at: number): { date: string; day: number; hour: number; year: number; dayStartUtc: number } {
  const local = new Date(at + BEIJING_OFFSET_MS)
  const year = local.getUTCFullYear()
  const month = local.getUTCMonth()
  const date = local.getUTCDate()
  return {
    date: `${year}-${String(month + 1).padStart(2, '0')}-${String(date).padStart(2, '0')}`,
    day: local.getUTCDay(),
    hour: local.getUTCHours(),
    year,
    dayStartUtc: Date.UTC(year, month, date) - BEIJING_OFFSET_MS
  }
}

function tierAt(at: number): { tier: PriceTier; holiday: boolean } {
  const local = beijingParts(at)
  if (local.year !== 2026) return { tier: 'unknown', holiday: false }
  const holiday = HOLIDAYS_2026.some(([start, end]) => local.date >= start && local.date <= end)
  if (holiday || local.day === 0 || local.day === 6) return { tier: 'off_peak', holiday }
  return { tier: local.hour >= 9 && local.hour < 12 || local.hour >= 14 && local.hour < 18 ? 'peak' : 'off_peak', holiday: false }
}

export function getPeakStatus(now = Date.now()): PeakStatus {
  const current = tierAt(now)
  if (current.tier === 'unknown') return current
  const start = beijingParts(now).dayStartUtc
  for (let day = 0; day < 20; day += 1) {
    for (const hour of [0, 9, 12, 14, 18]) {
      const candidate = start + day * 86_400_000 + hour * 3_600_000
      if (candidate <= now) continue
      const next = tierAt(candidate)
      if (next.tier === 'unknown') return current
      if (next.tier !== current.tier) return { ...current, nextChangeAt: candidate, nextTier: next.tier }
    }
  }
  return current
}

/** DeepSeek Flash's published rates (yuan per million tokens, the left
 *  column of the sheet — the cheaper of the two models): cache hits, cache
 *  misses, and output, each with a peak and an off-peak rate. The sheet
 *  lists no rate for cache *writes*, so a write is billed as a miss — that
 *  is the token being processed for the first time. */
export const DEEPSEEK_PRICES_YUAN_PER_MILLION = {
  peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
  off_peak: { cacheHit: 0.02, cacheMiss: 1, output: 4 }
} as const

export interface SpendTokens {
  input?: number
  output?: number
  cacheRead?: number
  cacheCreate?: number
}

/** What one stretch of usage costs in yuan, priced by the tier in force at
 *  `at` (defaults to now). Null when the tier cannot be determined — the
 *  caller shows nothing rather than inventing a number. */
export function usageSpendYuan(tokens: SpendTokens, at = Date.now()): number | null {
  const tier = getPeakStatus(at).tier
  if (tier === 'unknown') return null
  const price = DEEPSEEK_PRICES_YUAN_PER_MILLION[tier]
  const miss = (tokens.input ?? 0) + (tokens.cacheCreate ?? 0)
  const hit = tokens.cacheRead ?? 0
  const output = tokens.output ?? 0
  return (miss * price.cacheMiss + hit * price.cacheHit + output * price.output) / 1_000_000
}

/** "¥0.42" for amounts people care about, "¥0.0042" when it is small; two
 *  significant-ish digits, never a long tail. */
export function formatYuan(value: number): string {
  const yuan = Math.max(0, value)
  if (yuan >= 0.1) return `¥${yuan.toFixed(2)}`
  if (yuan >= 0.001) return `¥${yuan.toFixed(4)}`
  return `¥${yuan.toFixed(6)}`
}
