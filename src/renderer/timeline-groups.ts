import type { TimelineEntry } from '../shared/contracts'

/**
 * A streaming turn publishes the whole timeline up to 20 times a second, and every
 * publish carries freshly cloned entry objects. Rendering each of them again is what
 * starves the panel's main thread until clicks stop working — so compare by value and
 * let the unchanged rows bail out.
 */
export function sameTimelineEntry(a: TimelineEntry, b: TimelineEntry): boolean {
  if (a === b) return true
  if (a.kind !== b.kind || a.text !== b.text || a.time !== b.time || a.endedAt !== b.endedAt) return false
  const left = a.tool
  const right = b.tool
  if (!left || !right) return !left && !right
  return left.toolUseId === right.toolUseId && left.name === right.name && left.status === right.status &&
    left.input === right.input && left.output === right.output
}

export type TimelineGroup =
  | { kind: 'single'; entry: TimelineEntry }
  | { kind: 'turn'; user: TimelineEntry; items: TimelineEntry[] }

/**
 * One turn reads like a Codex / Claude Code transcript: thinking blocks, tool
 * calls and the model's own progress sentences stay in chronological order.
 * Nothing is folded into one big "thinking + execution" module — assistant text
 * between work items is the visible divider between segments.
 */
export function groupTimeline(entries: TimelineEntry[]): TimelineGroup[] {
  const groups: TimelineGroup[] = []
  let user: TimelineEntry | null = null
  let items: TimelineEntry[] = []
  for (const entry of entries) {
    if (entry.kind === 'user') {
      if (user) groups.push({ kind: 'turn', user, items })
      user = entry
      items = []
    } else if (user) {
      items.push(entry)
    } else {
      groups.push({ kind: 'single', entry })
    }
  }
  if (user) groups.push({ kind: 'turn', user, items })
  return groups
}

/**
 * The tail of the grouping the panel renders by default: at least
 * `minEntries` entries' worth of turns counted from the end, plus
 * `extraGroups` more once the reader has scrolled up for older history.
 * Returns the original array (same identity) when nothing is hidden, so the
 * memos above it survive untouched.
 */
export function tailWindow(groups: TimelineGroup[], minEntries: number, extraGroups: number): TimelineGroup[] {
  if (groups.length === 0) return groups
  let index = groups.length
  let entries = 0
  while (index > 0 && entries < minEntries) {
    const group = groups[index - 1]
    entries += group.kind === 'single' ? 1 : 1 + group.items.length
    index -= 1
  }
  index = Math.max(0, index - extraGroups)
  return index === 0 ? groups : groups.slice(index)
}

export type TurnSegment =
  | { kind: 'work'; id: string; items: TimelineEntry[] }
  | { kind: 'note'; entry: TimelineEntry }

/**
 * Inside a turn, consecutive thinking/tool entries form one collapsible work
 * cluster ("思考 12 秒 · Bash ×2、Read · 用时 1:32"); the model's own sentences
 * stay outside the clusters as visible dividers, so folding the work never
 * hides what it said.
 */
export function segmentTurn(items: TimelineEntry[]): TurnSegment[] {
  const segments: TurnSegment[] = []
  let work: TimelineEntry[] = []
  const flush = () => {
    if (work.length) segments.push({ kind: 'work', id: work[0].id, items: work })
    work = []
  }
  for (const entry of items) {
    if (entry.kind === 'thinking' || entry.kind === 'tool') work.push(entry)
    else {
      flush()
      segments.push({ kind: 'note', entry })
    }
  }
  flush()
  return segments
}
