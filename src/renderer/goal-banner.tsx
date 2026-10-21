import { useState } from 'react'
import type { AgentGoal } from '../shared/contracts'

function GoalIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="6.4" /><circle cx="10" cy="10" r="2.6" /><path d="M10 10 16.4 3.6" /><path d="M13.2 3.6h3.2v3.2" /></svg>
}

function StopIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5.6" y="5.6" width="8.8" height="8.8" rx="1.8" /></svg>
}

/** 目标条只留三样东西：靶子图标、可点开看全文的目标文本、实心停止按钮。
 *  轮数、剩余轮数、阶段、暂停原因这些标签都不再显示。 */
export function GoalBanner({ goal, onClear }: { goal: AgentGoal; onClear: () => void }) {
  const [expanded, setExpanded] = useState(false)
  return <div className={`panel-goal-banner${expanded ? ' is-expanded' : ''}`} aria-label="目标">
    <span className="panel-goal-banner-icon" aria-hidden="true"><GoalIcon /></span>
    <button type="button" className="panel-goal-banner-condition" aria-expanded={expanded}
      title={expanded ? '收起目标' : '点击查看目标全文'}
      onClick={() => setExpanded((open) => !open)}>{goal.condition}</button>
    <button type="button" className="panel-goal-stop" aria-label="停止目标" title="停止目标"
      disabled={goal.phase === 'stopping'} onClick={onClear}><StopIcon /></button>
  </div>
}
