import type { AgentGoal } from '../shared/contracts'

function StopIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="6" y="6" width="8" height="8" rx="1.6" /></svg>;
}

/** The CLI's running /goal, on its own line under the task strip: what the goal
 *  is, how many stop-hook rounds it has survived, and one icon to clear it. */
export function GoalBanner({ goal, onClear }: { goal: AgentGoal; onClear: () => void }) {
  return <div className="panel-goal-banner" aria-label="目标">
    <span className="panel-goal-banner-condition" title={goal.condition}>目标：{goal.condition}</span>
    {goal.iterations > 0 && <span className="panel-goal-banner-meta">已推进 {goal.iterations} 轮</span>}
    <button type="button" className="panel-goal-stop" aria-label="停止目标" title="停止目标" onClick={onClear}><StopIcon /></button>
  </div>;
}
