import type { BalanceLine, BalanceSnapshot } from '../shared/contracts'

interface BalanceResponse {
  is_available?: unknown
  balance_infos?: Array<{
    currency?: unknown
    total_balance?: unknown
    granted_balance?: unknown
    topped_up_balance?: unknown
  }>
}

export async function fetchDeepSeekBalance(apiKey: string, signal?: AbortSignal): Promise<BalanceSnapshot> {
  const timeout = AbortSignal.timeout(10_000)
  const response = await fetch('https://api.deepseek.com/user/balance', {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  })
  if (!response.ok) throw new Error(`余额查询失败：HTTP ${response.status}。`)
  const data = await response.json() as BalanceResponse
  if (typeof data.is_available !== 'boolean' || !Array.isArray(data.balance_infos)) {
    throw new Error('余额接口返回了无法识别的数据。')
  }
  const balances = data.balance_infos.map((line): BalanceLine => {
    if ((line.currency !== 'CNY' && line.currency !== 'USD') ||
      typeof line.total_balance !== 'string' ||
      typeof line.granted_balance !== 'string' ||
      typeof line.topped_up_balance !== 'string') {
      throw new Error('余额接口返回了无法识别的金额。')
    }
    return {
      currency: line.currency,
      total: line.total_balance,
      granted: line.granted_balance,
      toppedUp: line.topped_up_balance
    }
  })
  return { available: data.is_available, balances, checkedAt: new Date().toISOString() }
}
