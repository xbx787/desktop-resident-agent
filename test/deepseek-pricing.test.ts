import { describe, expect, it } from 'vitest'
import { getPeakStatus } from '../src/shared/deepseek-pricing'

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
