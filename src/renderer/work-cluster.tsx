import { Fragment, memo, useEffect, useState, type ReactNode } from 'react'
import type { TimelineEntry } from '../shared/contracts'
import { toolLabel } from '../shared/tool-labels'
import { thinkingDurationText, thinkingElapsedSeconds } from './thinking-item'
import { sameTimelineEntry } from './timeline-groups'

export interface WorkFacts {
  steps: number
  toolCount: number
  /** "执行命令 ×2、读取 ×1、搜索 ×1 等 4 类" — what actually ran, most used first. */
  toolSummary: string
  thinkingSeconds: number
  elapsedSeconds: number | null
}

function clockText(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
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

/** The header's one phrase: how long the stretch took. Thinking time is
 *  deliberately absent — every thinking row inside shows its own seconds once
 *  the cluster opens, and two timers side by side read as one too many. The
 *  tool breakdown likewise lives only in the hover title. */
export function workFactsParts(facts: WorkFacts): string[] {
  return facts.elapsedSeconds === null ? [] : [`用时 ${clockText(facts.elapsedSeconds)}`]
}

/** Everything the header knows, tool breakdown included — the hover title and
 *  the screen-reader label, which cannot rely on a mouse. */
export function workFactsText(facts: WorkFacts): string {
  const parts: string[] = []
  if (facts.thinkingSeconds > 0) parts.push(`思考 ${thinkingDurationText(facts.thinkingSeconds)}`)
  if (facts.toolCount > 0) parts.push(`${facts.toolCount} 项操作`, facts.toolSummary)
  if (facts.elapsedSeconds !== null) parts.push(`用时 ${clockText(facts.elapsedSeconds)}`)
  return parts.join('，')
}

function Chevron() {
  return <svg className="panel-cluster-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m8 4.8 5.2 5.2L8 15.2" /></svg>
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
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) { setOpen(false); return }
    // A stretch that is still running stays open: a transient non-running
    // snapshot used to close it for good mid-run (reported live), and its
    // rows are the live view of the work anyway. It folds once it ends.
    setOpen(true)
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])
  const facts = workFacts(items, now, running)
  const parts = workFactsParts(facts)
  const fullText = workFactsText(facts)
  return <details className={`panel-cluster${running ? ' is-running' : ''}`} open={open}
    onToggle={(event) => {
      if (running && !event.currentTarget.open) { event.currentTarget.open = true; return }
      setOpen(event.currentTarget.open)
    }}>
    <summary className="panel-cluster-summary" title={fullText} aria-label={`${fullText || '工作记录'}，单击${open ? '收起' : '展开'}`}>
      <Chevron />
      {parts.length > 0 && <span className="panel-cluster-facts">{parts.map((part) => <span key={part}>{part}</span>)}</span>}
      <span className={`panel-cluster-state${running ? ' is-running' : ''}`} aria-hidden="true">{running ? '…' : '✓'}</span>
    </summary>
    <div className="panel-cluster-body">{items.map((entry, index) => <Fragment key={entry.id}>{renderEntry(entry, running && index === items.length - 1)}</Fragment>)}</div>
  </details>
}, (prev, next) => prev.running === next.running && prev.renderEntry === next.renderEntry &&
  prev.items.length === next.items.length && prev.items.every((entry, index) => sameTimelineEntry(entry, next.items[index])))
