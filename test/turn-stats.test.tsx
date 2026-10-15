import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnStats } from '../src/renderer/turn-stats'
import { usageSpendYuan } from '../src/shared/deepseek-pricing'
import type { TimelineEntry } from '../src/shared/contracts'

function tool(id: string, name: string, input: string, status: 'done' | 'error' = 'done'): TimelineEntry {
  return { id, time: '2026-10-10T10:00:00.000Z', kind: 'tool', text: '', tool: { toolUseId: id, name, status, input } }
}

const metrics = { startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:08.000Z', usedTokens: 1234 }

describe('TurnStats', () => {
  it('counts the tools after the token figure and shows one counted tool line plus the failures', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} metrics={metrics} entries={[
      tool('a', 'Read', '{"file_path":"D:\\\\projects\\\\README.md"}'),
      tool('b', 'Bash', '{"command":"npm test"}'),
      tool('c', 'Read', '{"file_path":"D:\\\\projects\\\\panel.tsx"}'),
      tool('d', 'Edit', '{"file_path":"panel.tsx"}', 'error')
    ]} />)
    expect(html).toContain('4 次工具')
    // The failure count rides right after the tool count, in parentheses, so
    // the two read as one phrase.
    expect(html).toContain('4 次工具<span class="panel-turn-tools-errors">（1 次失败）</span>')
    // One line of type counts, most used first, spaced — never glued with
    // punctuation, and files are not named. Every type carries its count,
    // even a single run ("×1").
    expect(html).toContain('<span>读取 ×2</span><span>执行命令 ×1</span><span>编辑 ×1</span>')
    expect(html).not.toContain('·')
    expect(html).not.toContain('README')
    // Only the failed call is spelled out.
    expect(html).toContain('失败：编辑 panel.tsx')
    expect(html).toContain('panel-turn-tools-line is-error')
    // The count sits after the token figure, as asked.
    expect(html.indexOf('token')).toBeLessThan(html.indexOf('4 次工具'))
  })

  it('reads the output speed beside the token figure', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[]} metrics={{
      startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:08.000Z',
      usage: { total: 1234, input: 1000, output: 200 }
    }} />)
    // 200 generated tokens over 8 s of wall clock.
    expect(html).toContain('1.2K token（25 token/s）')
  })

  it('stays silent about speed when the turn is too short or the split is unknown', () => {
    const brief = renderToStaticMarkup(<TurnStats running={false} entries={[]} metrics={{
      startedAt: '2026-10-10T10:00:00.000Z', finishedAt: '2026-10-10T10:00:00.400Z',
      usage: { total: 1234, input: 1000, output: 200 }
    }} />)
    expect(brief).toContain('1.2K token')
    expect(brief).not.toContain('token/s')
    // A bare total (direct DeepSeek path) cannot tell output from input.
    const bare = renderToStaticMarkup(<TurnStats running={false} entries={[]} metrics={metrics} />)
    expect(bare).toContain('1.2K token')
    expect(bare).not.toContain('token/s')
  })

  it('hides the tool line when the turn ran no tools, and the whole footer when nothing happened', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} metrics={metrics} entries={[]} />)
    expect(html).not.toContain('次工具')
    expect(renderToStaticMarkup(<TurnStats running={false} entries={[]} />)).toBe('')
  })

  it('shows one recorded turn price and the conversation total only on the newest turn', () => {
    const older = renderToStaticMarkup(<TurnStats running={false} metrics={{ ...metrics, spentYuan: 0.12 }} entries={[]} />)
    const newest = renderToStaticMarkup(<TurnStats running={false} metrics={{ ...metrics, spentYuan: 0.08 }} spentYuan={0.20} entries={[]} />)
    expect(older).toContain('本轮花费')
    expect(older).toContain('¥0.12')
    expect(older).not.toContain('本对话已记录')
    expect(newest).toContain('¥0.08')
    expect(newest).toContain('本对话已记录 ¥0.20')
  })

  it('labels missing historic usage without fabricating zero tokens or zero cost', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[]} showMissingUsage />)
    expect(html).toContain('用量未记录')
    expect(html).not.toContain('0 token')
    expect(html).not.toContain('¥0')
  })

  it('keeps the verifiable transcript total without the estimate disclaimer', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[]} estimatedSpendYuan={0.125} metrics={{
      ...metrics,
      usage: { total: 1234, input: 1000, output: 234 },
      spentYuan: 0.001,
      usageSource: 'transcript_estimate'
    }} />)
    expect(html).toContain('转录可核对部分 ¥0.13')
    expect(html).not.toContain('非完整账单')
  })

  it('lays the bill out as a vertical sum: buckets, their rates, each row’s own price, a rule, then the total', () => {
    const usage = { total: 1_936_000, input: 160_000, output: 120_000, cacheRead: 1_620_000, cacheCreate: 36_000 }
    // 2026-10-12 02:00 UTC is a Monday 10:00 in Beijing — inside the peak window.
    const peakAt = Date.parse('2026-10-12T02:00:08.000Z')
    const peak = renderToStaticMarkup(<TurnStats running={false} entries={[]} metrics={{
      startedAt: '2026-10-12T01:59:00.000Z', finishedAt: new Date(peakAt).toISOString(), usage,
      spentYuan: usageSpendYuan(usage, peakAt) ?? 0
    }} />)
    expect(peak).toContain('panel-turn-formula')
    expect(peak).toContain('输入命中')
    expect(peak).not.toContain('缓存命中')
    expect(peak).toContain('×2')
    expect(peak).toContain('×0.04')
    expect(peak).toContain('×8')
    // Each row prices itself: 160K×2, 1.62M×0.04, 36K×2, 120K×8 (per million),
    // every figure at the same two decimals.
    expect(peak).toContain('= ¥0.32')
    expect(peak).toContain('= ¥0.06')
    expect(peak).toContain('= ¥0.07')
    expect(peak).toContain('= ¥0.96')
    // The rows sum to the footer total, which rides the same formula.
    expect(peak).toContain('panel-turn-usage-total')
    expect(peak).toContain('¥1.42')
    // The rule sits between the formula and the total, like a written sum.
    expect(peak.indexOf('panel-turn-formula')).toBeLessThan(peak.indexOf('panel-turn-usage-total'))

    // The weekend prices the same usage from the cheap column.
    const offAt = Date.parse('2026-10-10T10:00:08.000Z')
    const off = renderToStaticMarkup(<TurnStats running={false} entries={[]} metrics={{
      startedAt: '2026-10-10T10:00:00.000Z', finishedAt: new Date(offAt).toISOString(), usage,
      spentYuan: usageSpendYuan(usage, offAt) ?? 0
    }} />)
    expect(off).toContain('×1')
    expect(off).toContain('×0.02')
    expect(off).toContain('×4')
    expect(off).toContain('= ¥0.16')
    expect(off).toContain('= ¥0.03')
    expect(off).toContain('= ¥0.04')
    expect(off).toContain('= ¥0.48')
    expect(off).toContain('¥0.71')
  })
})
