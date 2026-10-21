import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SubagentTask } from '../shared/contracts'
import { formatDuration } from './duration'
import { toolLabel } from '../shared/tool-labels'

/** A finished subagent keeps its head for a beat so its ending is visible. */
const SUBAGENT_RETAIN_MS = 6_000

const STATUS_LABEL: Record<SubagentTask['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止'
}

function RobotIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true">
    <rect x="3.8" y="6.4" width="12.4" height="9.2" rx="2.6" />
    <path d="M10 3.2v3.2" />
    <circle cx="7.5" cy="10.9" r="1.05" className="panel-subagent-eye" />
    <circle cx="12.5" cy="10.9" r="1.05" className="panel-subagent-eye" />
    <path d="M8 13.6h4" />
  </svg>
}

function elapsedText(task: SubagentTask): string {
  const started = task.startedAt ? Date.parse(task.startedAt) : NaN
  const ended = task.endedAt ? Date.parse(task.endedAt) : NaN
  const settled = Number.isFinite(started) && Number.isFinite(ended) ? ended - started : task.durationMs
  const live = task.status === 'running' && Number.isFinite(started) ? Date.now() - started : undefined
  const ms = live ?? settled
  return ms !== undefined && ms > 0 ? formatDuration(Math.floor(ms / 1000)) : '—'
}

interface PopoverAnchor {
  left: number
  top: number
  bottom: number
}

/** Fixed on the body layer: the feed's scroll clip must not cut the pane. */
function popoverStyle(anchor: PopoverAnchor): Record<string, string | number> {
  const width = Math.min(300, window.innerWidth - 16)
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - width - 8))
  const spaceAbove = anchor.top
  const spaceBelow = window.innerHeight - anchor.bottom
  const openBelow = spaceAbove < 260 && spaceBelow > spaceAbove
  const maxHeight = Math.max(80, Math.min(280, (openBelow ? spaceBelow : spaceAbove) - 10))
  return openBelow
    ? { left, width, top: anchor.bottom + 6, maxHeight }
    : { left, width, bottom: window.innerHeight - anchor.top + 6, maxHeight }
}

function Steps({ task }: { task: SubagentTask }) {
  const entries = task.timeline ?? []
  if (!entries.length) return null
  return <ol className="panel-subagent-timeline">
    {entries.map((entry) => <li key={entry.id} className={`panel-subagent-step is-${entry.kind}`}>
      <span className="panel-subagent-step-mark" aria-hidden="true">
        {entry.kind === 'tool' ? (entry.tool?.status === 'running' ? '…' : entry.tool?.status === 'error' ? '!' : '✓') : '·'}
      </span>
      <span className="panel-subagent-step-text">{entry.kind === 'tool' && entry.tool ? toolLabel(entry.tool.name) : entry.text}</span>
    </li>)}
  </ol>
}

/**
 * One robot head per Task-tool subagent, living in the status row. Clicking a
 * head opens a compact read-only pane: identity, running counters, the child's
 * latest steps and the two controls the SDK exposes (background, stop).
 */
export function SubagentTray({ subagents, onBackgroundTask, onStopTask, onMessageSubagent }: {
  subagents?: SubagentTask[]
  onBackgroundTask?: (task: SubagentTask) => void
  onStopTask?: (task: SubagentTask) => void
  onMessageSubagent?: (task: SubagentTask, text: string) => void
}) {
  const [displayed, setDisplayed] = useState<SubagentTask[]>([])
  const [openTaskId, setOpenTaskId] = useState<string | null>(null)
  const [anchor, setAnchor] = useState<PopoverAnchor | null>(null)
  const [messageDraft, setMessageDraft] = useState('')
  const [messageSent, setMessageSent] = useState(false)
  const sentTimer = useRef<number | undefined>(undefined)
  const removalTimers = useRef(new Map<string, number>())
  const popoverRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    setMessageDraft('')
    setMessageSent(false)
  }, [openTaskId])
  useEffect(() => () => { if (sentTimer.current !== undefined) window.clearTimeout(sentTimer.current) }, [])

  // The main process prunes finished tasks from its map; the panel keeps the
  // last copy briefly so a child that just ended stays readable.
  useEffect(() => {
    const incoming = subagents ?? []
    const incomingIds = new Set(incoming.map((task) => task.taskId))
    const retain = (taskId: string): void => {
      if (removalTimers.current.has(taskId)) return
      const timer = window.setTimeout(() => {
        removalTimers.current.delete(taskId)
        setDisplayed((current) => current.filter((task) => task.taskId !== taskId))
      }, SUBAGENT_RETAIN_MS)
      removalTimers.current.set(taskId, timer)
    }
    setDisplayed((current) => {
      const next = new Map(current.map((task) => [task.taskId, task]))
      for (const task of incoming) {
        next.set(task.taskId, task)
        if (task.status === 'running') {
          const timer = removalTimers.current.get(task.taskId)
          if (timer !== undefined) {
            window.clearTimeout(timer)
            removalTimers.current.delete(task.taskId)
          }
        } else retain(task.taskId)
      }
      for (const task of current) {
        if (!incomingIds.has(task.taskId)) retain(task.taskId)
      }
      return [...next.values()]
    })
  }, [subagents])
  useEffect(() => () => {
    for (const timer of removalTimers.current.values()) window.clearTimeout(timer)
    removalTimers.current.clear()
  }, [])

  // Only an explicit outside click or Esc closes the pane. Scrolling, moving
  // the pointer over it and dragging its own scrollbar must never dismiss it.
  useEffect(() => {
    if (!openTaskId) return
    const closeOutside = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (popoverRef.current?.contains(target)) return
      if (target instanceof Element && target.closest('.panel-subagent-icons')) return
      setOpenTaskId(null)
    }
    const closeKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenTaskId(null)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    document.addEventListener('keydown', closeKey, true)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      document.removeEventListener('keydown', closeKey, true)
    }
  }, [openTaskId])

  if (!displayed.length) return null
  const openTask = displayed.find((task) => task.taskId === openTaskId)
  const sendMessage = (): void => {
    const text = messageDraft.trim()
    if (!text || !openTask || !onMessageSubagent) return
    onMessageSubagent(openTask, text)
    setMessageDraft('')
    setMessageSent(true)
    if (sentTimer.current !== undefined) window.clearTimeout(sentTimer.current)
    sentTimer.current = window.setTimeout(() => setMessageSent(false), 2_000)
  }
  return <>
    <span className="panel-subagent-icons" role="group" aria-label="子代理">
      {displayed.map((task) => <button key={task.taskId} type="button"
        className={`panel-subagent-icon is-${task.status}${openTaskId === task.taskId ? ' is-open' : ''}`}
        aria-label={`子代理：${task.description}，${STATUS_LABEL[task.status]}`}
        aria-expanded={openTaskId === task.taskId}
        title={task.description}
        onClick={(event) => {
          if (openTaskId === task.taskId) { setOpenTaskId(null); return }
          const rect = event.currentTarget.getBoundingClientRect()
          setAnchor({ left: rect.left, top: rect.top, bottom: rect.bottom })
          setOpenTaskId(task.taskId)
        }}>
        <RobotIcon />
      </button>)}
    </span>
    {openTask && anchor && createPortal(<div ref={popoverRef} className="panel-subagent-popover"
      style={popoverStyle(anchor)} role="dialog" aria-label={`子代理 ${displayed.indexOf(openTask) + 1}：${openTask.description}`}>
      <div className="panel-subagent-head">
        <span className={`panel-subagent-dot is-${openTask.status}`} aria-hidden="true" />
        <span className="panel-subagent-title">子代理 {displayed.indexOf(openTask) + 1}</span>
        <span className={`panel-subagent-state is-${openTask.status}`}>{STATUS_LABEL[openTask.status]}</span>
      </div>
      <p className="panel-subagent-desc" title={openTask.description}>{openTask.description}</p>
      {openTask.summary && <p className="panel-subagent-summary" title={openTask.summary}>{openTask.summary}</p>}
      <p className="panel-subagent-meta">
        {openTask.lastToolName ? `最近：${toolLabel(openTask.lastToolName)}` : '等待输出'}
        {' · '}{openTask.toolUses ?? 0} 次工具 · {elapsedText(openTask)}
      </p>
      <Steps task={openTask} />
      {(onBackgroundTask || onStopTask) && openTask.status === 'running' && <div className="panel-subagent-actions">
        {openTask.toolUseId && onBackgroundTask && !openTask.isBackgrounded &&
          <button type="button" onClick={() => onBackgroundTask(openTask)}>后台运行</button>}
        {onStopTask && <button type="button" className="is-stop" onClick={() => onStopTask(openTask)}>停止</button>}
      </div>}
      {openTask.status === 'running' && openTask.toolUseId && onMessageSubagent && <form className="panel-subagent-message"
        onSubmit={(event) => { event.preventDefault(); sendMessage() }}>
        <input value={messageDraft} maxLength={4_000}
          placeholder={messageSent ? '已转达' : '通过主对话转达'}
          aria-label="通过主对话转达给子代理"
          onChange={(event) => { setMessageDraft(event.target.value); setMessageSent(false) }} />
        <button type="submit" disabled={!messageDraft.trim()}>转达</button>
      </form>}
    </div>, document.body)}
  </>
}
