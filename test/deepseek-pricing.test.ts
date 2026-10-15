import { describe, expect, it } from 'vitest'
import { formatYuan, getPeakStatus, usageSpendYuan } from '../src/shared/deepseek-pricing'

const beijing = (value: string): number => Date.parse(`${value}+08:00`)

describe('DeepSeek peak and off-peak time', () => {
  it('excludes public holidays and weekend make-up workdays', () => {
    expect(getPeakStatus(beijing('2026-10-01T10:00:00')).tier).toBe('off_peak')
    expect(getPeakStatus(beijing('2026-10-10T15:00:00')).tier).toBe('off_peak')
  })

  it('switches at the two weekday windows in Beijing time', () => {
    expect(getPeakStatus(beijing('2026-10-08T08:59:59')).tier).toBe('off_peak')
    expect(getPeakStatus(beijing('2026-10-08T09:00:00')).tier).toBe('peak')
    expect(getPeakStatus(beijing('2026-10-08T12:00:00')).tier).toBe('off_peak')
    expect(getPeakStatus(beijing('2026-10-08T14:00:00')).tier).toBe('peak')
    expect(getPeakStatus(beijing('2026-10-08T18:00:00')).tier).toBe('off_peak')
  })

  it('finds the next real transition across holidays and avoids unverified years', () => {
    expect(getPeakStatus(beijing('2026-10-07T15:00:00')).nextChangeAt).toBe(beijing('2026-10-08T09:00:00'))
    expect(getPeakStatus(beijing('2027-01-04T10:00:00')).tier).toBe('unknown')
  })
})

describe('usage spend', () => {
  it('prices each bucket by the tier in force', () => {
    // 2026-10-08 is a Thursday: 10:00 is peak, 19:00 is off-peak.
    const peak = beijing('2026-10-08T10:00:00')
    const off = beijing('2026-10-08T19:00:00')
    const tokens = { input: 1_000_000, cacheRead: 1_000_000, output: 1_000_000 }
    expect(usageSpendYuan(tokens, peak)).toBeCloseTo(0.04 + 2 + 8, 6)
    expect(usageSpendYuan(tokens, off)).toBeCloseTo(0.02 + 1 + 4, 6)
  })

  it('bills cache writes as misses and refuses unknown years', () => {
    const off = beijing('2026-10-08T19:00:00')
    expect(usageSpendYuan({ cacheCreate: 1_000_000 }, off)).toBeCloseTo(1, 6)
    expect(usageSpendYuan({ output: 1_000_000 }, beijing('2027-03-01T10:00:00'))).toBeNull()
  })
})

describe('formatYuan', () => {
  it('keeps small amounts readable', () => {
    expect(formatYuan(0.4212)).toBe('¥0.42')
    expect(formatYuan(0.0042)).toBe('¥0.0042')
    expect(formatYuan(0.0000042)).toBe('¥0.000004')
    expect(formatYuan(0.00000002)).toBe('¥0.00000002')
  })
})
