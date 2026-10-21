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
  const leftImages = left.images ?? []
  const rightImages = right.images ?? []
  return left.toolUseId === right.toolUseId && left.name === right.name && left.status === right.status &&
    left.input === right.input && left.output === right.output &&
    leftImages.length === rightImages.length && leftImages.every((image, index) => image.path === rightImages[index]?.path)
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
type TurnGroup = Extract<TimelineGroup, { kind: 'turn' }>

/**
 * Groups by user message, with one guard against interrupt skew: a broken-off
 * turn drains late — its remaining entries reach the store *after* the next
 * user line is already written (the user's line is instant; model output
 * lags). An entry therefore belongs to the newest turn whose user message was
 * sent at or before its own timestamp, not merely to the nearest one by array
 * position. Entries with unusable timestamps keep the old positional rule.
 *
 * A steered message — sent while its turn was still running — does not open a
 * block of its own: it slots into the running turn in place. New records carry
 * the flag on the entry itself; for records written before it existed, a
 * message landing inside a finished turn's window (its user line →
 * finishedAt), or past the start of the live turn, is the same thing.
 */
export function groupTimeline(entries: TimelineEntry[], liveTurnStartMs?: number): TimelineGroup[] {
  const windows: Array<[number, number]> = []
  for (const entry of entries) {
    if (entry.kind !== 'user' || !entry.metrics?.finishedAt) continue
    const start = Date.parse(entry.time)
    const end = Date.parse(entry.metrics.finishedAt)
    if (Number.isFinite(start) && Number.isFinite(end)) windows.push([start, end])
  }
  const isSteered = (entry: TimelineEntry): boolean => {
    if (entry.interrupted) return true
    // A user line that received the turn's footer opened a turn of its own.
    if (entry.metrics) return false
    const sent = Date.parse(entry.time)
    if (!Number.isFinite(sent)) return false
    if (windows.some(([start, end]) => start <= sent && sent <= end)) return true
    // The live turn's own opening message sits a few milliseconds after the
    // turn's startedAt (that clock starts before the entry is written). Without
    // a grace window that message read as a steer and folded into the previous
    // turn — until the turn settled and it grew its own footer. Real steers
    // come seconds later, so a small margin separates the two cleanly.
    return liveTurnStartMs !== undefined && sent > liveTurnStartMs + 2000
  }
  const groups: TimelineGroup[] = []
  const turns: TurnGroup[] = []
  let current: TurnGroup | undefined
  let currentMs = Number.NEGATIVE_INFINITY
  for (const entry of entries) {
    // A system notice is not part of the dialogue: it keeps its own row and
    // never becomes a turn's final answer. Context compaction used to ride
    // inside the turn as the last note, so folding the process left only the
    // compaction line where the reply should be.
    if (entry.kind === 'system') {
      groups.push({ kind: 'single', entry })
      continue
    }
    // 重启分割条：它开启一个新 turn，后面的思考/命令/回复都挂在头像列右侧。
    if (entry.kind === 'user' && entry.divider) {
      const turn: TurnGroup = { kind: 'turn', user: entry, items: [] }
      turns.push(turn)
      groups.push(turn)
      current = turn
      const sent = Date.parse(entry.time)
      currentMs = Number.isFinite(sent) ? sent : Number.NEGATIVE_INFINITY
      continue
    }
    if (entry.kind === 'user') {
      if (current && isSteered(entry)) {
        current.items.push(entry)
        continue
      }
      const turn: TurnGroup = { kind: 'turn', user: entry, items: [] }
      turns.push(turn)
      groups.push(turn)
      current = turn
      const sent = Date.parse(entry.time)
      currentMs = Number.isFinite(sent) ? sent : Number.NEGATIVE_INFINITY
      continue
    }
    let owner = current
    const ms = Date.parse(entry.time)
    if (Number.isFinite(ms) && current && ms < currentMs) {
      owner = undefined
      for (const turn of turns) {
        const sent = Date.parse(turn.user.time)
        if (Number.isFinite(sent) && sent <= ms) owner = turn
      }
      owner ??= current
    }
    if (owner) owner.items.push(entry)
    else groups.push({ kind: 'single', entry })
  }
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
  | { kind: 'user'; entry: TimelineEntry }

/**
 * Inside a turn, consecutive thinking/tool entries form one collapsible work
 * cluster ("思考 12 秒 · Bash ×2、Read · 用时 1:32"); the model's own sentences
 * stay outside the clusters as visible dividers, so folding the work never
 * hides what it said. A steered user line is a segment of its own — the
 * shape the panel draws as a message in place.
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
    else if (entry.kind === 'user') {
      flush()
      segments.push({ kind: 'user', entry })
    } else {
      flush()
      segments.push({ kind: 'note', entry })
    }
  }
  flush()
  return segments
}

/**
 * Lifts every steered user line out of the turn's flow, in order. The panel
 * shows them stacked at the top of the turn; the process underneath then
 * folds whole, no matter how often it was interrupted — a fold that stopped
 * at the message left everything after it permanently open, which is exactly
 * the chain that would not close.
 */
export function liftAsides(segments: TurnSegment[]): { asides: Array<Extract<TurnSegment, { kind: 'user' }>>; flow: Array<Exclude<TurnSegment, { kind: 'user' }>> } {
  const asides: Array<Extract<TurnSegment, { kind: 'user' }>> = []
  const flow: Array<Exclude<TurnSegment, { kind: 'user' }>> = []
  for (const segment of segments) {
    if (segment.kind === 'user') asides.push(segment)
    else flow.push(segment)
  }
  return { asides, flow }
}

/**
 * A finished turn shows only its final answer: everything before the last
 * model sentence — work clusters and progress sentences alike — folds into
 * one row. A live turn folds nothing, its process is the view. A turn with
 * no sentence after its work keeps its clusters as they are. Steered lines
 * are not part of this input: they travel separately (see liftAsides).
 */
export function splitTurnTail<T extends TurnSegment>(segments: T[], live: boolean): { head: T[]; tail: T[] } {
  if (live) return { head: [], tail: segments }
  let lastNote = -1
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]
    // Only the model's own sentence can be the answer. System notices that
    // slipped into a stored turn keep their place in the flow instead of
    // replacing it.
    if (segment.kind === 'note' && segment.entry.kind === 'assistant') { lastNote = index; break }
  }
  return lastNote > 0 ? { head: segments.slice(0, lastNote), tail: segments.slice(lastNote) } : { head: [], tail: segments }
}
