import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { deleteTurnEntries } from '../src/main/agent-runtime'
import type { DialogueLine } from '../src/main/deepseek'

const at = (kind: TimelineEntry['kind'], text: string, seconds: number): TimelineEntry =>
  ({ id: `${kind}:${text}`, time: new Date(Date.parse('2026-10-12T00:00:00.000Z') + seconds * 1000).toISOString(), kind, text })

const timeline: TimelineEntry[] = [
  at('user', 'one', 0), at('thinking', 't1', 1), at('assistant', 'a1', 2),
  at('user', 'two', 10), at('thinking', 't2', 11), at('assistant', 'a2', 12),
  at('user', 'three', 20), at('assistant', 'a3', 21)
]
const history: DialogueLine[] = [
  { role: 'user', content: 'one' }, { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'two' }, { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'three' }, { role: 'assistant', content: 'a3' }
]

describe('deleteTurnEntries', () => {
  it('removes a middle turn from the timeline and its history in lockstep', () => {
    const next = deleteTurnEntries(timeline, history, 'user:two')
    expect(next.timeline.map((entry) => entry.text)).toEqual(['one', 't1', 'a1', 'three', 'a3'])
    expect(next.history.map((line) => line.content)).toEqual(['one', 'a1', 'three', 'a3'])
  })

  it('removes the last turn through to the end', () => {
    const next = deleteTurnEntries(timeline, history, 'user:three')
    expect(next.timeline.map((entry) => entry.text)).toEqual(['one', 't1', 'a1', 'two', 't2', 'a2'])
    expect(next.history.map((line) => line.content)).toEqual(['one', 'a1', 'two', 'a2'])
  })

  it('removes a turn whose history line has no reply yet', () => {
    const withPending = [...timeline, at('user', 'four', 30)]
    const pendingHistory: DialogueLine[] = [...history, { role: 'user', content: 'four' }]
    const next = deleteTurnEntries(withPending, pendingHistory, 'user:four')
    expect(next.timeline.map((entry) => entry.text)).toEqual(timeline.map((entry) => entry.text))
    expect(next.history).toEqual(history)
  })

  it('refuses to guess when the history cannot be aligned', () => {
    const withPending = [...timeline, at('user', 'four', 30)]
    expect(() => deleteTurnEntries(withPending, history, 'user:four')).toThrow('历史记录与消息对不上')
  })

  it('refuses an id that is not a user entry', () => {
    expect(() => deleteTurnEntries(timeline, history, 'assistant:a1')).toThrow('这轮对话已经找不到了')
    expect(() => deleteTurnEntries(timeline, history, 'user:nope')).toThrow('这轮对话已经找不到了')
  })
})
