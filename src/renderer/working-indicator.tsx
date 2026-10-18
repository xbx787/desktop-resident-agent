import { useEffect, useRef, useState } from 'react'
import type { TaskStatus } from '../shared/contracts'
import { formatDuration } from './duration'
import { toolLabel } from '../shared/tool-labels'

/** What the assistant is busy with right now, in the user's words. The point is
 *  that the panel says something during the gaps — while the message is still
 *  travelling, while the model thinks between tool calls, while a command runs —
 *  instead of leaving the timeline unchanged until the next token arrives. */
export function workingPhrase(input: { sending: boolean; thinking: boolean; status: TaskStatus; tool?: string; compacting?: boolean; compactingAuto?: boolean }): string | null {
  // Compaction outranks thinking and tools: while it runs, nothing else moves.
  if (input.compacting) return input.compactingAuto ? '正在自动压缩上下文' : '正在压缩上下文'
  if (input.sending) return '正在发送消息'
  if (input.thinking) return '正在思考'
  switch (input.status) {
    case 'planning': return '正在理解你的需求'
    case 'executing': {
      if (!input.tool) return '正在执行工具'
      const label = toolLabel(input.tool)
      // Chinese labels are verb phrases — "正在读取", not "正在执行 读取". Tools
      // without a label keep their own name and the wordier wording.
      if (label === '子任务') return '正在执行子任务'
      return label === input.tool ? `正在执行 ${input.tool}` : `正在${label}`
    }
    case 'verifying': return '正在整理结果'
    default: return null
  }
}

export function WorkingIndicator({ sending, thinking, status, tool, compacting, compactingAuto, startedAt }: {
  sending: boolean
  thinking: boolean
  status: TaskStatus
  tool?: string
  compacting?: boolean
  compactingAuto?: boolean
  startedAt?: string
}) {
  const phrase = workingPhrase({ sending, thinking, status, tool, compacting, compactingAuto })
  const mountedAt = useRef(Date.now())
  const [now, setNow] = useState(mountedAt.current)
  useEffect(() => {
    if (!phrase) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [phrase])
  if (!phrase) return null
  const parsed = startedAt ? Date.parse(startedAt) : NaN
  const since = Number.isFinite(parsed) ? parsed : mountedAt.current
  const elapsed = Math.max(0, Math.floor((now - since) / 1000))
  return <div className="panel-working" role="status" aria-live="polite" aria-label={`${phrase}${elapsed >= 1 ? `，已进行 ${elapsed} 秒` : ''}`}>
    <span className="panel-working-dots" aria-hidden="true"><i /><i /><i /></span>
    <span className="panel-working-text">{phrase}</span>
    {elapsed >= 1 && <span className="panel-working-time">{formatDuration(elapsed)}</span>}
  </div>
}
