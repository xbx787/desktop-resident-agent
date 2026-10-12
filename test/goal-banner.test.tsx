// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoalBanner } from '../src/renderer/goal-banner'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('GoalBanner', () => {
  it('shows the condition, hides the round count at zero, and clears through the icon button', async () => {
    const onClear = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<GoalBanner goal={{ condition: '把目标模式做完', phase: 'requested', startedAt: new Date().toISOString() }} onClear={onClear} />))
    expect(container.querySelector('.panel-goal-banner-condition')?.textContent).toContain('把目标模式做完')
    expect(container.querySelector('.panel-goal-banner-meta')?.textContent).toBe('已请求')
    await act(async () => container!.querySelector<HTMLButtonElement>('.panel-goal-stop')!.click())
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('shows the round count once the stop hook has advanced it', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<GoalBanner goal={{ condition: '写完测试', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 3 }} onClear={() => undefined} />))
    expect(container.querySelector('.panel-goal-banner-meta')?.textContent).toContain('已推进 3 轮')
  })
})
