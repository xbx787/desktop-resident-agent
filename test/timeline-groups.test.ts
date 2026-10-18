import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { groupTimeline, liftAsides, segmentTurn, splitTurnTail, tailWindow, type TimelineGroup } from '../src/renderer/timeline-groups'

const BASE = Date.parse('2026-10-09T00:00:00.000Z')
let sequence = 0
const entry = (kind: TimelineEntry['kind'], text: string): TimelineEntry =>
  ({ id: `${kind}:${text}`, time: new Date(BASE + (sequence++) * 1000).toISOString(), kind, text })
const at = (kind: TimelineEntry['kind'], text: string, seconds: number): TimelineEntry =>
  ({ id: `${kind}:${text}`, time: new Date(BASE + seconds * 1000).toISOString(), kind, text })

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

  it('returns an interrupted turn’s late entries to their own user message', () => {
    const first = { ...at('user', 'first', 0), metrics: { startedAt: new Date(BASE).toISOString(), usedTokens: 17 } }
    const second = { ...at('user', 'second', 4), metrics: { startedAt: new Date(BASE + 4000).toISOString(), usedTokens: 23 } }
    const groups = groupTimeline([
      first,
      at('thinking', 'first turn thought', 2),
      second,                                  // sent while the first turn was still running
      at('assistant', 'first turn answer', 3),  // drains late, after 'second' was written
      at('thinking', 'second turn thought', 5)
    ])
    expect(groups).toHaveLength(2)
    const [firstGroup, secondGroup] = groups
    if (firstGroup.kind !== 'turn' || secondGroup.kind !== 'turn') throw new Error('expected turn groups')
    expect(firstGroup.items.map((item) => item.text)).toEqual(['first turn thought', 'first turn answer'])
    expect(secondGroup.items.map((item) => item.text)).toEqual(['second turn thought'])
    expect(firstGroup.user.id).toBe(first.id)
    expect(firstGroup.user.metrics?.usedTokens).toBe(17)
    expect(secondGroup.user.id).toBe(second.id)
    expect(secondGroup.user.metrics?.usedTokens).toBe(23)
  })
})

describe('steered messages', () => {
  it('folds a flagged steer into the running turn instead of opening a block', () => {
    const groups = groupTimeline([
      at('user', 'first', 0),
      at('thinking', 'work before', 2),
      { ...at('user', 'steer', 4), interrupted: true },
      at('thinking', 'work after', 6)
    ])
    expect(groups).toHaveLength(1)
    const turn = groups[0]
    if (turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.user.text).toBe('first')
    expect(turn.items.map((item) => item.kind)).toEqual(['thinking', 'user', 'thinking'])
    expect(turn.items[1].text).toBe('steer')
  })

  it("reads an unflagged message inside a finished turn's window as a steer too", () => {
    const first = { ...at('user', 'first', 0), metrics: { startedAt: new Date(BASE).toISOString(), finishedAt: new Date(BASE + 9000).toISOString() } }
    const groups = groupTimeline([
      first,
      at('thinking', 'work before', 2),
      at('user', 'old steer', 4),
      at('thinking', 'work after', 6)
    ])
    expect(groups).toHaveLength(1)
    if (groups[0].kind !== 'turn') throw new Error('expected a turn group')
    expect(groups[0].items.some((item) => item.text === 'old steer')).toBe(true)
  })

  it('folds a message sent past the live turn start while that turn still runs', () => {
    const groups = groupTimeline([
      at('user', 'live turn', 0),
      at('thinking', 'work', 2),
      at('user', 'mid-turn', 4),
      at('thinking', 'more work', 6)
    ], BASE + 1000)
    expect(groups).toHaveLength(1)
    if (groups[0].kind !== 'turn') throw new Error('expected a turn group')
    expect(groups[0].items.map((item) => item.kind)).toEqual(['thinking', 'user', 'thinking'])
  })

  it('keeps the live turn’s own opening message out of the previous turn', () => {
    // 真实的时序：轮开始时先记 startedAt，消息条目随后才写——条目的时间比
    // 起点晚几毫秒。没有容差，这一轮自己的开场消息会被当成插话并进上一轮，
    // 等它结算后又自己跳回去（用户看到「顺序反复横跳」的那个 bug）。
    const opened: TimelineEntry = { ...at('user', 'after restart', 0), time: new Date(BASE + 60_005).toISOString() }
    const groups = groupTimeline([
      at('user', 'previous turn', 0),
      at('assistant', 'previous reply', 5),
      opened
    ], BASE + 60_000)
    expect(groups).toHaveLength(2)
    const second = groups[1]
    if (second.kind !== 'turn') throw new Error('expected a turn group')
    expect(second.user.text).toBe('after restart')
  })

  it('still opens a new block for a message sent after a finished turn', () => {
    const first = { ...at('user', 'first', 0), metrics: { startedAt: new Date(BASE).toISOString(), finishedAt: new Date(BASE + 3000).toISOString() } }
    const groups = groupTimeline([first, at('thinking', 'work', 2), at('user', 'next', 5), at('thinking', 'second work', 6)])
    expect(groups).toHaveLength(2)
    expect(groups.map((group) => group.kind === 'turn' ? group.user.text : '')).toEqual(['first', 'next'])
  })
})

describe('system notices', () => {
  it('keeps a notice out of the turn, so it cannot replace the answer', () => {
    const groups = groupTimeline([
      entry('user', 'one'),
      entry('assistant', 'answer'),
      entry('system', '上下文已压缩，可以继续当前对话。')
    ])
    expect(groups.map((group) => group.kind)).toEqual(['turn', 'single'])
    const turn = groups[0]
    if (turn.kind !== 'turn') throw new Error('expected a turn group')
    expect(turn.items.map((item) => item.text)).toEqual(['answer'])
    const notice = groups[1]
    if (notice.kind !== 'single') throw new Error('expected a single group')
    expect(notice.entry.text).toBe('上下文已压缩，可以继续当前对话。')
  })

  it('never lets a notice stand in for the final answer', () => {
    const { head, tail } = splitTurnTail(segmentTurn([
      at('thinking', 'work', 1),
      at('assistant', 'answer', 2),
      at('system', '上下文已压缩', 3)
    ]), false)
    expect(head.map((segment) => segment.kind)).toEqual(['work'])
    expect(tail.map((segment) => segment.kind === 'note' ? segment.entry.text : '')).toEqual(['answer', '上下文已压缩'])
  })
})

describe('segmentTurn', () => {
  it('lifts a steered user line out as a segment of its own', () => {
    const segments = segmentTurn([at('thinking', 't1', 1), at('user', 'steer', 2), at('assistant', 'reply', 3)])
    expect(segments.map((segment) => segment.kind)).toEqual(['work', 'user', 'note'])
  })
})

describe('liftAsides', () => {
  it('lifts a steered line out so the interrupted process folds whole', () => {
    const segments = segmentTurn([at('thinking', 't1', 1), at('user', 'steer', 2), at('thinking', 't2', 3), at('assistant', 'final', 4)])
    const { asides, flow } = liftAsides(segments)
    expect(asides.map((segment) => segment.entry.text)).toEqual(['steer'])
    expect(flow.map((segment) => segment.kind)).toEqual(['work', 'work', 'note'])
    // The fold no longer stops at the steer: the work on both sides of it
    // collapses together, so the chain can always be closed.
    const { head, tail } = splitTurnTail(flow, false)
    expect(head.map((segment) => segment.kind)).toEqual(['work', 'work'])
    expect(tail.map((segment) => segment.kind)).toEqual(['note'])
  })

  it('keeps several steered lines in order, stacked for the top of the turn', () => {
    const segments = segmentTurn([at('thinking', 't1', 1), at('user', 's1', 2), at('thinking', 't2', 3), at('user', 's2', 4)])
    const { asides, flow } = liftAsides(segments)
    expect(asides.map((segment) => segment.entry.text)).toEqual(['s1', 's2'])
    expect(flow.map((segment) => segment.kind)).toEqual(['work', 'work'])
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
