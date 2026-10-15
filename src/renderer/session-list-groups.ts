import type { ConversationSummary } from '../shared/contracts'

export type SessionListGroupKey = 'pinned' | 'seven-days' | 'thirty-days' | 'older'

export interface SessionListGroup {
  key: SessionListGroupKey
  label: string
  conversations: ConversationSummary[]
}

const DAY_MS = 86_400_000
const GROUPS: ReadonlyArray<{ key: SessionListGroupKey; label: string }> = [
  { key: 'pinned', label: '置顶' },
  { key: 'seven-days', label: '近 7 天' },
  { key: 'thirty-days', label: '近 30 天' },
  { key: 'older', label: '更早' }
]

function parseTime(value: string | null): number | null {
  if (typeof value !== 'string' || !value) return null
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : null
}

function timeGroup(time: number | null, now: number): SessionListGroupKey {
  if (time === null) return 'older'
  const age = Math.max(0, now - time)
  if (age <= 7 * DAY_MS) return 'seven-days'
  if (age <= 30 * DAY_MS) return 'thirty-days'
  return 'older'
}

/** Groups one library scope without changing its summaries. `updatedAt` is a
 * record modification time (renaming can change it), not a message activity
 * time. Archived rows use `archivedAt` instead. Invalid dates remain visible
 * in the older group and sort after valid dates. */
export function groupSessionSummaries(
  summaries: readonly ConversationSummary[],
  archived: boolean,
  now: number
): SessionListGroup[] {
  if (!Number.isFinite(now)) throw new RangeError('now must be a finite timestamp')

  const buckets = new Map<SessionListGroupKey, ConversationSummary[]>(
    GROUPS.map(({ key }) => [key, []])
  )
  for (const item of summaries) {
    if ((item.archivedAt !== null) !== archived) continue
    const time = parseTime(archived ? item.archivedAt : item.lastActivityAt)
    const key = !archived && item.pinnedAt !== null ? 'pinned' : timeGroup(time, now)
    buckets.get(key)!.push(item)
  }

  return GROUPS.filter(({ key }) => !archived || key !== 'pinned').flatMap(({ key, label }) => {
    const conversations = buckets.get(key)!
    if (conversations.length === 0) return []
    conversations.sort((left, right) => {
      const leftTime = parseTime(archived ? left.archivedAt : left.lastActivityAt) ?? -Infinity
      const rightTime = parseTime(archived ? right.archivedAt : right.lastActivityAt) ?? -Infinity
      return rightTime - leftTime || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    })
    return [{ key, label, conversations }]
  })
}
