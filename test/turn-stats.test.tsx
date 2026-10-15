import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TurnStats } from '../src/renderer/turn-stats'
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

  it('hides the tool line when the turn ran no tools, and the whole footer when nothing happened', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} metrics={metrics} entries={[]} />)
    expect(html).not.toContain('次工具')
    expect(renderToStaticMarkup(<TurnStats running={false} entries={[]} />)).toBe('')
  })

  it('shows one recorded turn price and the conversation total only on the newest turn', () => {
    const older = renderToStaticMarkup(<TurnStats running={false} metrics={{ ...metrics, spentYuan: 0.12 }} entries={[]} />)
    const newest = renderToStaticMarkup(<TurnStats running={false} metrics={{ ...metrics, spentYuan: 0.08 }} spentYuan={0.20} entries={[]} />)
    expect(older).toContain('本轮花费 ¥0.12')
    expect(older).not.toContain('本对话已记录')
    expect(newest).toContain('本轮花费 ¥0.0800')
    expect(newest).toContain('本对话已记录 ¥0.20')
  })

  it('labels missing historic usage without fabricating zero tokens or zero cost', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[]} showMissingUsage />)
    expect(html).toContain('用量未记录')
    expect(html).not.toContain('0 token')
    expect(html).not.toContain('¥0')
  })

  it('labels transcript recovered usage as an estimate rather than a complete bill', () => {
    const html = renderToStaticMarkup(<TurnStats running={false} entries={[]} estimatedSpendYuan={0.125} metrics={{
      ...metrics,
      usage: { total: 1234, input: 1000, output: 234 },
      spentYuan: 0.001,
      usageSource: 'transcript_estimate'
    }} />)
    expect(html).toContain('转录恢复的估算')
    expect(html).toContain('非完整账单')
    expect(html).toContain('转录可核对部分 ¥0.13')
  })
})
