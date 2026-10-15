import { describe, expect, it } from 'vitest'
import { compactTokens, tokenBreakdownRows } from '../src/renderer/token-usage'

describe('compactTokens', () => {
  it('reads the way a person would say the number', () => {
    expect(compactTokens(1_940_000)).toBe('1.94M')
    expect(compactTokens(2_000_000)).toBe('2M')
    expect(compactTokens(154_300)).toBe('154.3K')
    expect(compactTokens(160_000)).toBe('160K')
    expect(compactTokens(940)).toBe('940')
    expect(compactTokens(0)).toBe('0')
  })
})

describe('tokenBreakdownRows', () => {
  it('splits the total the way the endpoint billed it, tagged with its rate bucket', () => {
    expect(tokenBreakdownRows({ total: 1_936_000, input: 160_000, output: 120_000, cacheRead: 1_620_000, cacheCreate: 36_000 }))
      .toEqual([
        { label: '输入未命中', amount: '160K', tokens: 160_000, bucket: 'miss' },
        { label: '输入命中', amount: '1.62M', tokens: 1_620_000, bucket: 'hit' },
        { label: '缓存写入', amount: '36K', tokens: 36_000, bucket: 'miss' },
        { label: '输出', amount: '120K', tokens: 120_000, bucket: 'output' }
      ])
  })

  it('hides buckets the endpoint never reported', () => {
    expect(tokenBreakdownRows({ total: 900, input: 700, output: 200 })).toEqual([
      { label: '输入未命中', amount: '700', tokens: 700, bucket: 'miss' },
      { label: '输出', amount: '200', tokens: 200, bucket: 'output' }
    ])
    expect(tokenBreakdownRows({ total: 1_940_000 })).toEqual([])
  })
})
