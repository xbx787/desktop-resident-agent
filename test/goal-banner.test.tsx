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

async function mount(element: React.ReactElement): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(element))
  return container
}

describe('GoalBanner', () => {
  it('只留靶子图标、条件文本和停止按钮，不再显示轮数与阶段标签', async () => {
    const onClear = vi.fn()
    const host = await mount(<GoalBanner goal={{ condition: '把目标模式做完', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 3 }} onClear={onClear} />)
    expect(host.querySelector('.panel-goal-banner-icon svg')).toBeTruthy()
    expect(host.querySelector('.panel-goal-banner-condition')?.textContent).toBe('把目标模式做完')
    expect(host.textContent).not.toContain('目标：')
    expect(host.querySelector('.panel-goal-banner-meta')).toBeNull()
    expect(host.querySelector('.panel-goal-banner-budget')).toBeNull()
    expect(host.querySelector('.panel-goal-banner-reason')).toBeNull()
    expect(host.querySelector('.panel-goal-resume')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('.panel-goal-stop')!.click())
    expect(onClear).toHaveBeenCalledTimes(1)
  })

  it('点击条件文本展开全文，再点收起', async () => {
    const host = await mount(<GoalBanner goal={{ condition: '一个很长很长的目标条件，需要点开才能看到全文', phase: 'confirmed', startedAt: new Date().toISOString() }} onClear={() => undefined} />)
    const condition = host.querySelector<HTMLButtonElement>('.panel-goal-banner-condition')!
    expect(condition.getAttribute('aria-expanded')).toBe('false')
    expect(host.querySelector('.panel-goal-banner')?.classList.contains('is-expanded')).toBe(false)
    await act(async () => condition.click())
    expect(condition.getAttribute('aria-expanded')).toBe('true')
    expect(host.querySelector('.panel-goal-banner')?.classList.contains('is-expanded')).toBe(true)
    await act(async () => condition.click())
    expect(condition.getAttribute('aria-expanded')).toBe('false')
  })
})
