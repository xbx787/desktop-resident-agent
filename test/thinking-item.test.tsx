import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { ThinkingItem, thinkingDurationText, thinkingElapsedSeconds } from '../src/renderer/thinking-item'

const block: TimelineEntry = { id: 't1', time: '2026-10-09T00:00:00.000Z', kind: 'thinking', text: '先确认一下文件结构。' }

describe('thinking timing', () => {
  it('counts up while the block is still open', () => {
    expect(thinkingElapsedSeconds(block, Date.parse('2026-10-09T00:00:12.400Z'))).toBe(12)
  })

  it('freezes at the end timestamp once the block closes', () => {
    const closed = { ...block, endedAt: '2026-10-09T00:01:05.000Z' }
    expect(thinkingElapsedSeconds(closed, Date.parse('2026-10-09T00:10:00.000Z'))).toBe(65)
    expect(thinkingDurationText(9)).toBe('9 秒')
    expect(thinkingDurationText(65)).toBe('1 分 5 秒')
    expect(thinkingDurationText(120)).toBe('2 分')
  })
})

describe('ThinkingItem', () => {
  it('renders a live block collapsed by default and labelled 思考中', () => {
    const html = renderToStaticMarkup(<ThinkingItem entry={block} running />)
    expect(html).toContain('is-streaming')
    expect(html).toContain('思考中')
    expect(html).toContain('panel-live-label')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
    expect(html).toContain('先确认一下文件结构。')
  })

  it('renders a finished block collapsed with its frozen 已思考 duration', () => {
    const html = renderToStaticMarkup(<ThinkingItem entry={{ ...block, endedAt: '2026-10-09T00:00:07.000Z' }} running={false} />)
    expect(html).toContain('panel-thought')
    expect(html).toContain('已思考')
    expect(html).toContain('7 秒')
    expect(html).not.toContain('is-streaming')
    expect(html).not.toContain('panel-live-label')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })
})
