import { memo, useEffect, useRef, useState } from 'react'
import type { AgentTask } from './agent-tasks'

/** One compact fraction, done over total — "17/17" reads at a glance. What is
 *  running lives in the icon state and the list, not in more words here. */
export function taskCounts(tasks: readonly AgentTask[]): string[] {
  const done = tasks.filter((task) => task.status === 'completed').length
  return [`${done}/${tasks.length}`]
}

const marks: Record<AgentTask['status'], string> = { pending: '○', in_progress: '…', completed: '✓' }

/**
 * The plan's little dashboard, right above the text box. It stands for as long
 * as the conversation holds unfinished tasks — freshly born, reopened or
 * resumed — and answers to task state alone: plan mode only expands it when
 * switched on. A fully completed list folds the whole strip away.
 */
export const TaskStrip = memo(function TaskStrip({ tasks, planMode }: { tasks: AgentTask[]; planMode: boolean }) {
  const working = tasks.some((task) => task.status !== 'completed')
  const done = tasks.filter((task) => task.status === 'completed').length
  const [open, setOpen] = useState(true)
  const prevCount = useRef(tasks.length)
  const prevPlan = useRef(planMode)
  useEffect(() => {
    const wasEmpty = prevCount.current === 0
    prevCount.current = tasks.length
    if (wasEmpty && tasks.length > 0) setOpen(true)
  }, [tasks.length])
  useEffect(() => {
    const wasOn = prevPlan.current
    prevPlan.current = planMode
    if (!wasOn && planMode) setOpen(true)
  }, [planMode])
  useEffect(() => { if (!working) setOpen(false) }, [working])
  if (!working || !tasks.length) return null
  return <div className={`panel-tasks${working ? ' is-working' : ''}`} aria-label="任务列表">
    <button type="button" className="panel-tasks-summary" aria-expanded={open} aria-label={`任务，已完成 ${done}，共 ${tasks.length} 项`} onClick={() => setOpen(!open)}>
      <svg className="panel-tasks-icon" viewBox="0 0 20 20" aria-hidden="true"><path d="M4 5.5h12M4 10h12M4 14.5h8" /><path d="m14 14.8 1.8 1.6 2.7-3" /></svg>
      <span className="panel-tasks-title">任务</span>
      <span className="panel-tasks-counts">{taskCounts(tasks).map((part) => <span key={part}>{part}</span>)}</span>
      <svg className={`panel-tasks-chevron${open ? ' is-open' : ''}`} viewBox="0 0 20 20" aria-hidden="true"><path d="m5.2 7.6 4.8 4.8 4.8-4.8" /></svg>
    </button>
    {open && <ul className="panel-tasks-list">{tasks.map((task) => <li key={task.id} className={`panel-task is-${task.status}`}>
      <span className="panel-task-mark" aria-hidden="true">{marks[task.status]}</span>
      <span className="panel-task-subject">{task.subject}</span>
    </li>)}</ul>}
  </div>
})
