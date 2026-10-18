import { useEffect, useState } from 'react'
import type { AgentGoal } from '../shared/contracts'

function StopIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.6" /></svg>;
}

const phaseLabel = {
  requested: '已请求',
  confirmed: '运行中',
  stopping: '停止中',
  unverified: '状态未确认'
} as const

function remainingBudget(goal: AgentGoal, maxIterations: number | undefined,
  maxMinutes: number | undefined, now: number): string[] {
  const parts: string[] = []
  if (goal.iterations !== undefined && maxIterations !== undefined) {
    parts.push(`剩 ${Math.max(0, maxIterations - goal.iterations)} 轮`)
  }
  const started = Date.parse(goal.startedAt)
  if (maxMinutes !== undefined && Number.isFinite(started)) {
    const remaining = maxMinutes * 60_000 - (now - started)
    if (remaining <= 0) parts.push('时间已到上限')
    else {
      const minutes = Math.ceil(remaining / 60_000)
      parts.push(minutes >= 60 ? `剩 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `剩 ${minutes} 分钟`)
    }
  }
  return parts
}

/** Show only SDK-confirmed iteration counts; local turns are not goal rounds.
 *  Budget and the stop hook's last reason come from the settings and the
 *  active_goal event; a paused queue can be resumed without sending text. */
export function GoalBanner({ goal, onClear, maxIterations, maxMinutes, pausedReason, onResume }: {
  goal: AgentGoal
  onClear: () => void
  maxIterations?: number
  maxMinutes?: number
  pausedReason?: string
  onResume?: () => void
}) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (maxMinutes === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [maxMinutes, goal.startedAt])
  const budget = remainingBudget(goal, maxIterations, maxMinutes, now)
  return <div className="panel-goal-banner" aria-label="目标" title={goal.statusMessage}>
    <span className="panel-goal-banner-condition" title={goal.condition}>目标：{goal.condition}</span>
    <span className="panel-goal-banner-meta">{phaseLabel[goal.phase]}{goal.iterations !== undefined ? `，已推进 ${goal.iterations} 轮` : ''}</span>
    {budget.length > 0 && <span className="panel-goal-banner-budget">{budget.join(' · ')}</span>}
    {goal.lastReason && <span className="panel-goal-banner-reason" title={goal.lastReason}>上次未达成：{goal.lastReason}</span>}
    {pausedReason && <span className="panel-goal-banner-pause" title={pausedReason}>{pausedReason}</span>}
    {pausedReason && onResume && <button type="button" className="panel-goal-resume" onClick={onResume}>继续</button>}
    <button type="button" className="panel-goal-stop" aria-label="停止目标" title="停止目标" disabled={goal.phase === 'stopping'} onClick={onClear}><StopIcon /></button>
  </div>;
}
