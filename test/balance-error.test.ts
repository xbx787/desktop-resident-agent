import { describe, expect, it } from 'vitest'
import { balanceErrorMessage } from '../src/renderer/balance-error'

describe('balance error text', () => {
  it('turns Electron IPC errors into actionable text without exposing internals', () => {
    const message = balanceErrorMessage(new Error("Error invoking remote method 'pet:get-balance': Error: 请在设置中添加 DeepSeek API Key。"))
    expect(message).toBe('请在设置中添加 DeepSeek API Key。')
    expect(message).not.toContain('pet:get-balance')
  })

  it('reports invalid credentials, throttling and network errors without echoing raw data', () => {
    expect(balanceErrorMessage(new Error('余额查询失败：HTTP 401。'))).toContain('无效')
    expect(balanceErrorMessage(new Error('余额查询失败：HTTP 429。'))).toContain('频繁')
    expect(balanceErrorMessage(new Error('fetch failed: sk-private-value'))).not.toContain('sk-private-value')
  })
})
