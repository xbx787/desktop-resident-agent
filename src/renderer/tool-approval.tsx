import { useState } from 'react'
import type { ToolPermissionRequest } from '../shared/contracts'

/**
 * A tool call parked in one of the asking permission modes. It takes over the
 * composer slot — the same place questions and plans use — so the answer is
 * one click away and the turn stays paused until it is given.
 */
export function ToolApprovalPanel({ request, onDecide }: {
  request: ToolPermissionRequest
  onDecide: (allow: boolean) => Promise<boolean>
}) {
  const [busy, setBusy] = useState(false)

  async function decide(allow: boolean): Promise<void> {
    if (busy) return
    setBusy(true)
    if (!await onDecide(allow)) setBusy(false)
  }

  return <div className="panel-permission" aria-label="等待允许的工具调用">
    <section className="panel-permission-block">
      <span className="panel-permission-header">需要允许</span>
      <p className="panel-permission-summary">{request.summary}</p>
      {request.input.trim() && <details className="panel-permission-detail">
        <summary>查看参数</summary>
        <pre>{request.input}</pre>
      </details>}
    </section>
    <div className="panel-permission-actions">
      <button type="button" className="panel-permission-deny" disabled={busy} onClick={() => { void decide(false) }}>拒绝</button>
      <button type="button" className="panel-permission-allow" disabled={busy} onClick={() => { void decide(true) }}>{busy ? '发送中…' : '允许'}</button>
    </div>
  </div>
}
