import { Fragment, memo, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TimelineEntry } from '../shared/contracts'
import { toolLabel } from '../shared/tool-labels'
import { thinkingDurationText, thinkingElapsedSeconds } from './thinking-item'
import { sameTimelineEntry, type TurnSegment } from './timeline-groups'

export interface WorkFacts {
  steps: number
  toolCount: number
  /** "执行命令 ×2、读取 ×1、搜索 ×1 等 4 类" — what actually ran, most used first. */
  toolSummary: string
  thinkingSeconds: number
  elapsedSeconds: number | null
}

function toolSummaryOf(names: string[]): string {
  const counts = new Map<string, number>()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1] || names.indexOf(a[0]) - names.indexOf(b[0]))
  const head = ordered.slice(0, 3).map(([name, count]) => `${name} ×${count}`).join('、')
  return ordered.length > 3 ? `${head} 等 ${ordered.length} 类` : head
}

/** Everything the collapsed header has to answer: how long it thought, what it
 *  ran, how many commands, how long the whole stretch took. */
export function workFacts(items: TimelineEntry[], nowMs: number, running: boolean): WorkFacts {
  const tools = items
    .filter((entry) => entry.kind === 'tool')
    .map((entry) => toolLabel(entry.tool?.name ?? (entry.text.trim().split(/\r?\n/, 1)[0].split(' · ')[0] || '工具')))
  const thinkingSeconds = items
    .filter((entry) => entry.kind === 'thinking')
    .reduce((sum, entry) => sum + (thinkingElapsedSeconds(entry, nowMs) ?? 0), 0)
  const started = items.length ? Date.parse(items[0].time) : NaN
  const last = items[items.length - 1]
  const ended = running ? nowMs : last?.endedAt ? Date.parse(last.endedAt) : Date.parse(last?.time ?? '')
  const elapsedSeconds = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, Math.floor((ended - started) / 1000)) : null
  return { steps: items.length, toolCount: tools.length, toolSummary: toolSummaryOf(tools), thinkingSeconds, elapsedSeconds }
}

/** The header's extra fact: how many operations ran. No clock — a per-second
 *  number forced the live row to repaint every second and kept restarting its
 *  sheen animation. The hover title carries the rest. */
export function workFactsParts(facts: WorkFacts): string[] {
  return facts.toolCount > 0 ? [`${facts.toolCount} 项操作`] : []
}

/** Everything the header knows, tool breakdown included — the hover title and
 *  the screen-reader label, which cannot rely on a mouse. */
export function workFactsText(facts: WorkFacts): string {
  const parts: string[] = []
  if (facts.thinkingSeconds > 0) parts.push(`思考 ${thinkingDurationText(facts.thinkingSeconds)}`)
  if (facts.toolCount > 0) parts.push(`${facts.toolCount} 项操作`, facts.toolSummary)
  return parts.join('，')
}

function Chevron() {
  return <svg className="panel-cluster-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4.8 5.2 5.2L8 15.2" /></svg>
}

/** The header's state word, shaped after a thinking row's 「思考中/已思考」:
 *  live while the stretch runs, settled once it ends. The bare clock beside it
 *  stays the only number on the row. */
function ClusterLabel({ running }: { running: boolean }) {
  return <span className={`panel-cluster-label${running ? ' panel-live-label' : ''}`}>{running ? '正在工作' : '已工作'}</span>
}

/**
 * One stretch of uninterrupted work: thinking blocks and tool calls folded into
 * a single row that states what it did. Live while it runs, folded once the run
 * moves on; clicking the header opens the underlying rows again.
 */
export const WorkCluster = memo(function WorkCluster({ items, running, renderEntry }: {
  items: TimelineEntry[]
  running: boolean
  renderEntry: (entry: TimelineEntry, running: boolean) => ReactNode
}) {
  const [open, setOpen] = useState(running)
  // A fold made by hand sticks, live or not: the running row used to refuse
  // the click. Only the automatic fold at the end still closes it.
  const foldedByHandRef = useRef(false)
  useEffect(() => {
    if (!running) { setOpen(false); return }
    // A stretch that is still running opens on its own: a transient
    // non-running snapshot used to close it for good mid-run (reported live),
    // and its rows are the live view of the work anyway. It folds once it
    // ends — but a fold the owner made by hand is not reopened.
    if (!foldedByHandRef.current) setOpen(true)
  }, [running])
  const facts = workFacts(items, Date.now(), running)
  const parts = workFactsParts(facts)
  const fullText = workFactsText(facts)
  const fold = () => {
    foldedByHandRef.current = true
    setOpen(false)
  }
  return <details className={`panel-cluster${running ? ' is-running' : ''}`} open={open}
    onToggle={(event) => {
      foldedByHandRef.current = !event.currentTarget.open
      setOpen(event.currentTarget.open)
    }}>
    <summary className="panel-cluster-summary" title={fullText} aria-label={`${fullText || '工作记录'}，单击${open ? '收起' : '展开'}`}>
      <Chevron />
      <ClusterLabel running={running} />
      {parts.length > 0 && <span className="panel-cluster-facts">{parts.map((part) => <span key={part}>{part}</span>)}</span>}
      <span className={`panel-cluster-state${running ? ' is-running' : ''}`} aria-hidden="true">{running ? '…' : '✓'}</span>
    </summary>
    <div className="panel-cluster-body">{items.map((entry, index) => <Fragment key={entry.id}>{renderEntry(entry, running && index === items.length - 1)}</Fragment>)}</div>
    {/* 展开时最底下的一行：箭头落在竖线的中轴上，点它把整段收起。
        标题本身也能收，但长链滚到底之后，这一行就在手边。 */}
    <button type="button" className="panel-cluster-fold" onClick={fold}>
      <span className="panel-cluster-fold-arrow" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="m5 12 5-5 5 5" /></svg></span>
      <span>收起</span>
    </button>
  </details>
}, (prev, next) => prev.running === next.running && prev.renderEntry === next.renderEntry &&
  prev.items.length === next.items.length && prev.items.every((entry, index) => sameTimelineEntry(entry, next.items[index])))

function sameSegment(a: TurnSegment, b: TurnSegment): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'note' && b.kind === 'note') return sameTimelineEntry(a.entry, b.entry)
  if (a.kind === 'user' && b.kind === 'user') return sameTimelineEntry(a.entry, b.entry)
  if (a.kind === 'work' && b.kind === 'work') {
    return a.items.length === b.items.length && a.items.every((entry, index) => sameTimelineEntry(entry, b.items[index]))
  }
  return false
}

/**
 * A finished turn folded whole: every work cluster and progress sentence
 * before the turn's final answer collapses into one row, so what stays in
 * sight is the outcome. Clicking the header lays the process back out — the
 * same clusters and sentences, not a different view of them.
 */
export const TurnProcess = memo(function TurnProcess({ segments, renderEntry, renderNote }: {
  segments: TurnSegment[]
  renderEntry: (entry: TimelineEntry, running: boolean) => ReactNode
  renderNote: (entry: TimelineEntry) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const items = segments.flatMap((segment) => segment.kind === 'work' ? segment.items : [segment.entry])
  // A finished stretch: every span is closed, so the clock never reads nowMs.
  const facts = workFacts(items, 0, false)
  const parts = workFactsParts(facts)
  const fullText = workFactsText(facts)
  return <details className="panel-cluster is-turn-process" open={open}
    onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="panel-cluster-summary" title={fullText} aria-label={`过程：${fullText || '工作记录'}，单击${open ? '收起' : '展开'}`}>
      <Chevron />
      <ClusterLabel running={false} />
      {parts.length > 0 && <span className="panel-cluster-facts">{parts.map((part) => <span key={part}>{part}</span>)}</span>}
      <span className="panel-cluster-state" aria-hidden="true">✓</span>
    </summary>
    <div className="panel-cluster-body">{segments.map((segment) => segment.kind === 'work'
      ? <WorkCluster key={segment.id} items={segment.items} running={false} renderEntry={renderEntry} />
      : <Fragment key={segment.entry.id}>{renderNote(segment.entry)}</Fragment>)}
    </div>
  </details>
}, (prev, next) => prev.renderEntry === next.renderEntry && prev.renderNote === next.renderNote &&
  prev.segments.length === next.segments.length && prev.segments.every((segment, index) => sameSegment(segment, next.segments[index])))
