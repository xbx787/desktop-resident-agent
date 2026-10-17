// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BalanceSnapshot } from '../src/shared/contracts'
import { BalanceCard } from '../src/renderer/balance'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 余额卡省下了一行：更新时间贴在标题的「余额」后面，底部那行只在有提示时
 *  才回来——正常状态卡片少一行，金额区更舒展。（2026-10-16 10:03 UTC 是
 *  上海时间 18:03。） */

const snapshot: BalanceSnapshot = {
  available: true,
  balances: [{ currency: 'CNY', total: '248.59', granted: '0', toppedUp: '248.59' }],
  checkedAt: '2026-10-16T10:03:00.000Z'
}

describe('the balance card layout', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
  })

  const mount = async (line: BalanceSnapshot, error: string | null = null): Promise<void> => {
    await act(async () => {
      root.render(<BalanceCard visible snapshot={line} loading={false} error={error} onRefresh={() => undefined} onClose={() => undefined} />)
    })
  }

  it('keeps the checked time beside 余额 and drops the bottom row', async () => {
    await mount(snapshot)
    const heading = host.querySelector('.balance-heading')!
    expect(heading.textContent).toContain('余额')
    expect(heading.querySelector('.balance-updated')?.textContent).toBe('18:03')
    // 正常状态：底部那行整个不在，卡片不多占一行。
    expect(host.querySelector('.balance-foot')).toBeNull()
    expect(host.querySelector('.balance-peek')!.className).not.toContain('has-notice')
  })

  it('brings the notice row back when the account cannot be queried', async () => {
    await mount({ ...snapshot, available: false })
    expect(host.querySelector('.balance-foot')?.textContent).toContain('账户当前不可调用 API')
    expect(host.querySelector('.balance-peek')!.className).toContain('has-notice')
    // 时间仍留在标题行——它不该跟着提示行一起消失。
    expect(host.querySelector('.balance-updated')?.textContent).toBe('18:03')
  })
})
