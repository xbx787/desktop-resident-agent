import { useState } from 'react'
import { MessageMarkdown } from './message-markdown'
import type { PlanApprovalRequest } from '../shared/contracts'

/**
 * The parked ExitPlanMode, shown where the composer usually sits. The plan
 * arrives as Markdown and is read as a document; 开始执行 lets the CLI leave
 * plan mode and implement it, 继续调整 rejects it so the model stays in plan
 * mode and revises before proposing again.
 */
export function PlanApprovalPanel({ request, onDecide }: {
  request: PlanApprovalRequest
  onDecide: (approved: boolean) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)

  async function decide(approved: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    if (!await onDecide(approved)) setBusy(false)
  }

  return <div className="panel-plan" aria-label="等待批准的计划">
    <section className="panel-plan-block">
      <span className="panel-plan-header">计划</span>
      <div className="panel-plan-text"><MessageMarkdown text={request.plan} /></div>
    </section>
    <div className="panel-plan-actions">
      <button type="button" className="panel-plan-revise" disabled={busy} onClick={() => { void decide(false) }}>继续调整</button>
      <button type="button" className="panel-plan-approve" disabled={busy} onClick={() => { void decide(true) }}>{busy ? '发送中…' : '开始执行'}</button>
    </div>
  </div>
}
