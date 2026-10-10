/** Why a native turn failed, and what the host should do about it. */
export type AgentFailureKind = 'authentication' | 'configuration' | 'transport' | 'process-exited' | 'session-missing' | 'unknown'

export interface AgentFailure {
  kind: AgentFailureKind
  /** A user-facing sentence naming what broke. */
  message: string
  /** The session id the CLI rejected as unknown, when it said so. */
  missingSessionId?: string
  /** Keeping this resume id would just fail the same way again. */
  invalidatesSession: boolean
}

/** Carries the classified verdict across layers so the runtime can act on it
 *  (drop the dead resume id) instead of just printing a message. */
export class AgentTurnError extends Error {
  constructor(readonly failure: AgentFailure) {
    super(failure.message)
    this.name = 'AgentTurnError'
  }
}

/** Turns whatever the SDK threw into an actionable verdict: a named cause, a
 *  sentence the panel can show as-is, and whether the stored resume id is
 *  still usable. Shape checks come first; text matching is the fallback for
 *  the CLI's free-form errors. */
export function classifyAgentFailure(error: unknown): AgentFailure {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const text = raw.toLowerCase()

  // The CLI says this when the on-disk transcript for a resume id is gone;
  // capture the id so the caller can confirm it is the one it meant to use.
  const missing = raw.match(/no conversation found with session id:?\s*([\w-]+)/i)
  if (missing) {
    return {
      kind: 'session-missing',
      message: '云端会话记录已失效；本地记录仍在，下一条消息会带着它重新开始。',
      missingSessionId: missing[1],
      invalidatesSession: true
    }
  }
  if (/401|403|unauthorized|invalid api key|invalid_api_key|authentication/.test(text)) {
    return { kind: 'authentication', message: 'DeepSeek 认证失败：请检查 API Key 是否有效、余额是否充足。', invalidatesSession: false }
  }
  if (/econnrefused|econnreset|etimedout|enotfound|fetch failed|socket hang up|socket closed|network error|proxy/i.test(text)) {
    return { kind: 'transport', message: '连接 DeepSeek 失败（网络或代理不可达）。检查网络后重试即可。', invalidatesSession: true }
  }
  if (/process exited|epipe|terminated|sigkill|sigterm|killed|会话意外结束/.test(text)) {
    return { kind: 'process-exited', message: 'Claude Code 进程意外退出；下一条消息会自动重新启动它。', invalidatesSession: true }
  }
  if (/enoent|eacces|spawn|not found|permission denied/.test(text)) {
    return { kind: 'configuration', message: raw || 'Claude Code 启动失败。', invalidatesSession: false }
  }
  return { kind: 'unknown', message: raw || 'Claude Agent 运行失败。', invalidatesSession: false }
}
