import { memo, useEffect, useState } from 'react'
import type { TimelineEntry } from '../shared/contracts'
import { MessageMarkdown } from './message-markdown'

/** Seconds a thinking block has been running; null when the timestamps are unusable. */
export function thinkingElapsedSeconds(entry: Pick<TimelineEntry, 'time' | 'endedAt'>, nowMs: number): number | null {
  const started = Date.parse(entry.time)
  if (!Number.isFinite(started)) return null
  const ended = entry.endedAt ? Date.parse(entry.endedAt) : nowMs
  if (!Number.isFinite(ended)) return null
  return Math.max(0, Math.floor((ended - started) / 1000))
}

export function thinkingDurationText(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes} 分 ${rest} 秒` : `${minutes} 分`
}

function ThoughtIcon() {
  return <svg className="panel-thought-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M9.5 3.2c.9 3.1 1.7 3.9 4.8 4.8-3.1.9-3.9 1.7-4.8 4.8-.9-3.1-1.7-3.9-4.8-4.8 3.1-.9 3.9-1.7 4.8-4.8Z" /><path d="M15 12.3c.4 1.5.8 1.9 2.3 2.3-1.5.4-1.9.8-2.3 2.3-.4-1.5-.8-1.9-2.3-2.3 1.5-.4 1.9-.8 2.3-2.3Z" /></svg>
}

/**
 * One thinking block, rendered like the tool rows: a summary you click open
 * (collapsed by default). While the model is still thinking the elapsed
 * seconds tick in real time on the summary and the text grows with the stream
 * behind a click; once the block closes it folds and freezes at "已思考 N 秒".
 */
export const ThinkingItem = memo(function ThinkingItem({ entry, running }: { entry: TimelineEntry; running: boolean }) {
  const streaming = running && !entry.endedAt
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!streaming) {
      setOpen(false)
      return
    }
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [streaming])
  const elapsed = entry.endedAt || streaming ? thinkingElapsedSeconds(entry, now) : null
  const duration = elapsed === null ? null : thinkingDurationText(elapsed)
  const label = streaming ? '思考中' : '已思考'
  return <details className={`panel-thought${streaming ? ' is-streaming' : ''}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary aria-label={`${label}${duration ? ` ${duration}` : ''}，单击${open ? '收起' : '展开'}思考内容`}>
      <ThoughtIcon />
      <span className={`panel-thought-label${streaming ? ' panel-live-label' : ''}`}>{label}</span>
      {duration && <span className="panel-thought-time">{duration}</span>}
      <span className={`panel-thought-state${streaming ? ' is-running' : ''}`} aria-hidden="true">{streaming ? '…' : '✓'}</span>
    </summary>
    <MessageMarkdown text={entry.text} streaming={streaming} />
  </details>
}, (prev, next) => prev.running === next.running && prev.entry.text === next.entry.text &&
  prev.entry.time === next.entry.time && prev.entry.endedAt === next.entry.endedAt)
