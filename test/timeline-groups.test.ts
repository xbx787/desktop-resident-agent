import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { groupTimeline, tailWindow, type TimelineGroup } from '../src/renderer/timeline-groups'

const entry = (kind: TimelineEntry['kind'], text: string): TimelineEntry => ({ id: `${kind}:${text}`, time: '2026-10-09T00:00:00.000Z', kind, text })

describe('groupTimeline', () => {
  it('keeps thinking, tools and the model’s own sentences in chronological order', () => {
    const groups = groupTimeline([
      entry('user', 'task'),
      entry('thinking', '先看看目录'),
      entry('tool', 'Read'),
      entry('assistant', '配置文件看完了，接下来改代码。'),
      entry('thinking', '再想想'),
      entry('tool', 'Bash'),
      entry('assistant', '完成了。')
    ])
    expect(groups).toHaveLength(1)
    const turn = groups[0]
    if (turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.user.text).toBe('task')
    expect(turn.items.map((item) => item.kind)).toEqual(['thinking', 'tool', 'assistant', 'thinking', 'tool', 'assistant'])
    expect(turn.items.map((item) => item.text)).toContain('配置文件看完了，接下来改代码。')
  })

  it('splits on every user message and keeps pre-user entries as singles', () => {
    const groups = groupTimeline([
      entry('system', 'boot'), entry('assistant', 'hi'), entry('user', 'one'), entry('tool', 'Read'), entry('user', 'two'), entry('assistant', 'done')
    ])
    expect(groups.map((group) => group.kind)).toEqual(['single', 'single', 'turn', 'turn'])
    const last = groups[3]
    if (last.kind !== 'turn') throw new Error('expected a turn group')
    expect(last.user.text).toBe('two')
    expect(last.items.map((item) => item.text)).toEqual(['done'])
  })

  it('keeps a user message with no replies yet as an empty turn', () => {
    const groups = groupTimeline([entry('user', 'pending')])
    expect(groups).toHaveLength(1)
    const turn = groups[0]
    if (turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.items).toEqual([])
  })
})

describe('tailWindow', () => {
  const turn = (id: string, items: number): TimelineGroup => ({
    kind: 'turn',
    user: entry('user', id),
    items: Array.from({ length: items }, (_, index) => entry('tool', `${id}-${index}`))
  })

  it('keeps the whole array (same identity) when it is already small', () => {
    const groups = [turn('a', 3), turn('b', 3)]
    expect(tailWindow(groups, 240, 0)).toBe(groups)
  })

  it('windows to at least minEntries worth of turns counted from the end', () => {
    const groups = Array.from({ length: 40 }, (_, index) => turn(`t${index}`, 9)) // 10 entries each
    const windowed = tailWindow(groups, 240, 0)
    expect(windowed).toHaveLength(24)
    expect(windowed[windowed.length - 1]).toBe(groups[39])
  })

  it('extends by whole turns as the reader scrolls up, never past the start', () => {
    const groups = Array.from({ length: 40 }, (_, index) => turn(`t${index}`, 9))
    expect(tailWindow(groups, 240, 6)).toHaveLength(30)
    expect(tailWindow(groups, 240, 100)).toBe(groups)
  })
})
