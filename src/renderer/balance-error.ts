/** Electron prefixes rejected IPC messages with internal channel details. */
export function balanceErrorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : ''
  if (/DeepSeek API Key|API Key.*配置|API Key.*添加/.test(message)) {
    return /HTTP\s+(401|403)|无效|无权/.test(message)
      ? 'DeepSeek API Key 无效或无权查询余额。'
      : '请在设置中添加 DeepSeek API Key。'
  }
  if (/HTTP\s+(401|403)/.test(message)) return 'DeepSeek API Key 无效或无权查询余额。'
  if (/HTTP\s+429/.test(message)) return '查询过于频繁，请稍后重试。'
  if (/HTTP\s+5\d\d/.test(message)) return 'DeepSeek 服务暂时不可用。'
  if (/网络|network|fetch failed|AbortError|TimeoutError/i.test(message)) return '网络连接失败，请稍后重试。'
  return '余额查询失败，请稍后重试。'
}
