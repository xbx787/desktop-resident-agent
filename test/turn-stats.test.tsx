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
    // A running turn whose backend has not reported output yet reads as "not
    // counted yet" — never as a lying "0 token/s".
    const uncounted = renderToStaticMarkup(<TurnStats running entries={[]} metrics={{
      startedAt: new Date(Date.now() - 20_000).toISOString(),
      usage: { total: 1234, input: 1000, output: 0 }
    }} />)
    expect(uncounted).toContain('1.2K token')
    expect(uncounted).not.toContain('token/s')
  })

  it('estimates the output while the backend withholds it mid-stream', () => {
    const streaming: TimelineEntry = { id: 'a1', kind: 'assistant', time: new Date().toISOString(), text: '一'.repeat(300) }
    const html = renderToStaticMarkup(<TurnStats running entries={[streaming]} metrics={{
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      usage: { total: 3000, input: 2000, output: 0 }
    }} />)
    // 300 字符 ÷ 1.5 ≈ 200 token：思考中「输出」不再挂着 0；速度则一律等到
    // 结算后才有（思考中途这个后端不报输出量，估算速率不可信）。
    expect(html).toContain('输出')
    expect(html).toContain('>200<')
    expect(html).not.toContain('token/s')
    // 没有流式文字时不该凭空造数。
    const idle = renderToStaticMarkup(<TurnStats running entries={[]} metrics={{
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      usage: { total: 3000, input: 2000, output: 0 }
    }} />)
    expect(idle).not.toContain('token/s')
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
    expect(older).not.toContain('本对话累计')
    expect(newest).toContain('¥0.08')
    // 对话累计坐在合计下面，措辞写明它是累计——不是这一轮的加法结果。
    expect(newest).toContain('本对话累计 ¥0.20')
  })

  it('labels missing historic usage without fabricating zero tokens or zero cost', () => {
    const reply: TimelineEntry = { id: 'a1', kind: 'assistant', time: '2026-10-10T10:00:06.000Z', text: '处理完了。' }
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[reply]} showMissingUsage />)
    expect(html).toContain('用量未记录')
    expect(html).not.toContain('0 token')
    expect(html).not.toContain('¥0')
  })

  it('draws no dot while a turn has no reply to land on', () => {
    // 用户刚发下、还没回答的一轮：没有点、没有桥、没有「用量未记录」——孤点
    // 带着一截桥悬在最后一句用户话下面，就是「一根线断成两节」那两节。
    const user: TimelineEntry = { id: 'u1', kind: 'user', time: '2026-10-10T10:00:00.000Z', text: '新消息' }
    expect(renderToStaticMarkup(<TurnStats running={false} entries={[user]} showMissingUsage />)).toBe('')
    const counted = renderToStaticMarkup(<TurnStats running={false} metrics={metrics} entries={[user]} />)
    expect(counted).not.toContain('panel-turn-stats-dot')
    // 跑动中的轮仍有点：线还在走，终点在那里。
    const live = renderToStaticMarkup(<TurnStats running entries={[user]} metrics={{ startedAt: new Date().toISOString(), usedTokens: 500 }} />)
    expect(live).toContain('panel-turn-stats-dot')
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
    // 旧行名是「缓存命中 N」；「缓存命中率」是另一条注记，不算它。
    expect(peak).not.toContain('缓存命中 ')
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
    // 合计行永远在，而且就是四行小计加起来的结果。
    expect(off).toContain('本轮合计')
    expect(off).toContain('panel-turn-usage-total-amount')
    // 谷时：乘数与合计标记都走柔和绿。
    expect(off).toContain('panel-turn-formula-mult is-off-peak')
    expect(off).toContain('<i class="panel-turn-tier is-off-peak">谷</i>')
    expect(off).not.toContain('is-peak')
    // 缓存命中率：1.62M 命中 ÷（160K 未命中 + 1.62M 命中）≈ 91%。
    expect(off).toContain('缓存命中率 91%')
    // 峰时：同一对色里的柔和红。
    expect(peak).toContain('panel-turn-formula-mult is-peak')
    expect(peak).toContain('<i class="panel-turn-tier is-peak">峰</i>')
  })

  it('gives the rule a result under it even while the turn still runs', () => {
    const usage = { total: 1_936_000, input: 160_000, output: 120_000, cacheRead: 1_620_000, cacheCreate: 36_000 }
    const html = renderToStaticMarkup(<TurnStats running entries={[]} metrics={{
      startedAt: new Date(Date.now() - 8_000).toISOString(), usage
    }} />)
    // 跑动中的一轮没有本轮精算值；合计仍要由各行算出来，横线下面不能空着。
    expect(html).toContain('本轮合计')
    expect(html).toContain('panel-turn-usage-total')
    expect(html).toContain('panel-turn-usage-total-amount')
  })
})
