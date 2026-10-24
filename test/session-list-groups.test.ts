import { describe, expect, it } from 'vitest'
import type { ConversationSummary } from '../src/shared/contracts'
import { groupSessionSummaries } from '../src/renderer/session-list-groups'

const DAY_MS = 86_400_000
const NOW = Date.parse('2026-10-14T00:00:00.000Z')
const ago = (days: number, extraMs = 0): string => new Date(NOW - days * DAY_MS - extraMs).toISOString()

function summary(id: string, options: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id, title: id, createdAt: ago(40), updatedAt: ago(1), lastActivityAt: ago(1), archivedAt: null,
    pinnedAt: null, mode: 'dsh', taskStatus: 'idle', messageCount: 0, preview: '',
    ...options
  }
}

describe('groupSessionSummaries', () => {
  it('puts pinned sessions first and groups unpinned sessions at inclusive 7/30-day boundaries', () => {
    const items = [
      summary('older', { lastActivityAt: ago(30, 1) }),
      summary('month', { lastActivityAt: ago(30) }),
      summary('week', { lastActivityAt: ago(7) }),
      summary('pinned', { lastActivityAt: ago(50), pinnedAt: ago(1) }),
      summary('after-week', { lastActivityAt: ago(7, 1) })
    ]
    const groups = groupSessionSummaries(items, false, NOW)
    expect(groups.map(({ key, label, conversations }) => [key, label, conversations.map(({ id }) => id)])).toEqual([
      ['pinned', '置顶', ['pinned']],
      ['seven-days', '近 7 天', ['week']],
      ['thirty-days', '近 30 天', ['after-week', 'month']],
      ['older', '更早', ['older']]
    ])
    expect(items.map(({ id }) => id)).toEqual(['older', 'month', 'week', 'pinned', 'after-week'])
  })

  it('sorts each section by its relevant timestamp then stable ID', () => {
    const items = [
      summary('z', { lastActivityAt: ago(1) }),
      summary('b', { lastActivityAt: ago(2) }),
      summary('a', { lastActivityAt: ago(1) }),
      summary('pin-old', { pinnedAt: ago(1), updatedAt: ago(4) }),
      summary('pin-new', { pinnedAt: ago(4), updatedAt: ago(1) })
    ]
    const groups = groupSessionSummaries(items, false, NOW)
    expect(groups[0].conversations.map(({ id }) => id)).toEqual(['pin-new', 'pin-old'])
    expect(groups[1].conversations.map(({ id }) => id)).toEqual(['a', 'z', 'b'])
  })

  it('uses archivedAt in the archive scope and ignores stale pinnedAt', () => {
    const items = [
      summary('active', { lastActivityAt: ago(1) }),
      summary('archived-old', { lastActivityAt: ago(1), archivedAt: ago(40), pinnedAt: ago(1) }),
      summary('archived-new', { lastActivityAt: ago(50), archivedAt: ago(2) })
    ]
    expect(groupSessionSummaries(items, true, NOW).map(({ key, conversations }) =>
      [key, conversations.map(({ id }) => id)])).toEqual([
      ['seven-days', ['archived-new']],
      ['older', ['archived-old']]
    ])
    expect(groupSessionSummaries(items, false, NOW).flatMap(({ conversations }) =>
      conversations.map(({ id }) => id))).toEqual(['active'])
  })

  it('keeps invalid timestamps visible as older and treats future timestamps as recent', () => {
    const items = [
      summary('invalid', { lastActivityAt: 'invalid date' }),
      summary('future', { lastActivityAt: new Date(NOW + DAY_MS).toISOString() }),
      summary('invalid-archive', { archivedAt: 'invalid date' })
    ]
    expect(groupSessionSummaries(items, false, NOW).map(({ key, conversations }) =>
      [key, conversations.map(({ id }) => id)])).toEqual([
      ['seven-days', ['future']], ['older', ['invalid']]
    ])
    expect(groupSessionSummaries(items, true, NOW).map(({ key, conversations }) =>
      [key, conversations.map(({ id }) => id)])).toEqual([['older', ['invalid-archive']]])
  })

  it('hides empty groups and rejects an invalid reference time', () => {
    expect(groupSessionSummaries([], false, NOW)).toEqual([])
    expect(groupSessionSummaries([summary('one')], false, NOW).map(({ key }) => key)).toEqual(['seven-days'])
    expect(() => groupSessionSummaries([], false, NaN)).toThrow(RangeError)
  })
})
