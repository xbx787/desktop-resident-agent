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

/** Show only SDK-confirmed iteration counts; local turns are not goal rounds. */
export function GoalBanner({ goal, onClear }: { goal: AgentGoal; onClear: () => void }) {
  return <div className="panel-goal-banner" aria-label="目标" title={goal.statusMessage}>
    <span className="panel-goal-banner-condition" title={goal.condition}>目标：{goal.condition}</span>
    <span className="panel-goal-banner-meta">{phaseLabel[goal.phase]}{goal.iterations !== undefined ? `，已推进 ${goal.iterations} 轮` : ''}</span>
    <button type="button" className="panel-goal-stop" aria-label="停止目标" title="停止目标" disabled={goal.phase === 'stopping'} onClick={onClear}><StopIcon /></button>
  </div>;
}
