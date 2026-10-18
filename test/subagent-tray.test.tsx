// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubagentTray } from '../src/renderer/subagent-tray'
import type { SubagentTask } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
  vi.useRealTimers()
})

function makeTask(taskId: string, description: string, overrides: Partial<SubagentTask> = {}): SubagentTask {
  return { taskId, toolUseId: `tool-${taskId}`, description, subagentType: 'Explore',
    status: 'running', startedAt: new Date().toISOString(), ...overrides }
}

async function render(tasks: SubagentTask[], callbacks: {
  onBackgroundTask?: (task: SubagentTask) => void
  onStopTask?: (task: SubagentTask) => void
} = {}) {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => root!.render(<SubagentTray subagents={tasks} {...callbacks} />))
}

describe('SubagentTray', () => {
  it('renders one robot head per subagent and nothing when there are none', async () => {
    await render([])
    expect(container!.querySelectorAll('.panel-subagent-icon')).toHaveLength(0)
    await render([makeTask('t1', '研究协议'), makeTask('t2', '查历史'), makeTask('t3', '写摘要')])
    const icons = container!.querySelectorAll('.panel-subagent-icon')
    expect(icons).toHaveLength(3)
    expect(icons[0]?.getAttribute('aria-label')).toContain('研究协议')
  })

  it('opens a compact read-only pane with the counters and the child timeline', async () => {
    const task = makeTask('t1', '研究协议', {
      toolUses: 3, totalTokens: 1_200, lastToolName: 'Read',
      timeline: [
        { id: 'text-1', time: new Date().toISOString(), kind: 'assistant', text: '看到两份文档' },
        { id: 'tool-1', time: new Date().toISOString(), kind: 'tool', text: '读取（已完成）',
          tool: { toolUseId: 'inner-1', name: 'Read', status: 'done' } }
      ]
    })
    await render([task])
    await act(async () => container!.querySelector<HTMLButtonElement>('.panel-subagent-icon')!.click())
    const pane = document.querySelector('.panel-subagent-popover')
    expect(pane).not.toBeNull()
    expect(pane!.textContent).toContain('研究协议')
    expect(pane!.textContent).toContain('3 次工具')
    expect(pane!.textContent).toContain('最近：读取')
    expect(pane!.textContent).not.toContain('token')
    expect(pane!.textContent).toContain('看到两份文档')
    expect(pane!.textContent).toContain('读取')
    // The first line names the kind and its ordinal; there is no footer note.
    expect(pane!.querySelector('.panel-subagent-head')?.textContent).toContain('子代理 1')
    expect(pane!.textContent).not.toContain('不支持向子代理发消息')
    expect([...pane!.querySelectorAll('button')].map((button) => button.textContent))
      .not.toContain('发消息')
  })

  it('never closes because of scrolling or pointer movement inside the pane', async () => {
    await render([makeTask('t1', '跑很久')])
    await act(async () => container!.querySelector<HTMLButtonElement>('.panel-subagent-icon')!.click())
    const pane = document.querySelector<HTMLElement>('.panel-subagent-popover')!
    await act(async () => { pane.dispatchEvent(new Event('scroll', { bubbles: true })) })
    expect(document.querySelector('.panel-subagent-popover')).not.toBeNull()
    await act(async () => { pane.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(document.querySelector('.panel-subagent-popover')).not.toBeNull()
    // An explicit outside click is the one thing that dismisses it.
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })) })
    expect(document.querySelector('.panel-subagent-popover')).toBeNull()
  })

  it('switches between subagents without closing the pane', async () => {
    const first = makeTask('t1', '研究协议', {
      timeline: [{ id: 'a', time: new Date().toISOString(), kind: 'assistant', text: '协议步骤一' }]
    })
    const second = makeTask('t2', '查历史', {
      timeline: [{ id: 'b', time: new Date().toISOString(), kind: 'assistant', text: '历史结论' }]
    })
    await render([first, second])
    const icons = () => container!.querySelectorAll<HTMLButtonElement>('.panel-subagent-icon')
    await act(async () => icons()[0]!.click())
    expect(document.querySelector('.panel-subagent-popover')?.textContent).toContain('协议步骤一')
    await act(async () => icons()[1]!.click())
    expect(document.querySelector('.panel-subagent-popover')?.textContent).toContain('历史结论')
    expect(document.querySelector('.panel-subagent-popover')?.textContent).not.toContain('协议步骤一')
    await act(async () => icons()[1]!.click())
    expect(document.querySelector('.panel-subagent-popover')).toBeNull()
  })

  it('offers background and stop for a running subagent only', async () => {
    const onBackgroundTask = vi.fn()
    const onStopTask = vi.fn()
    const task = makeTask('t1', '跑很久')
    await render([task], { onBackgroundTask, onStopTask })
    await act(async () => container!.querySelector<HTMLButtonElement>('.panel-subagent-icon')!.click())
    const pane = () => document.querySelector<HTMLElement>('.panel-subagent-popover')!
    expect([...pane().querySelectorAll<HTMLButtonElement>('.panel-subagent-actions button')]
      .map((button) => button.textContent)).toEqual(['后台运行', '停止'])
    const buttons = pane().querySelectorAll<HTMLButtonElement>('.panel-subagent-actions button')
    await act(async () => buttons[0]!.click())
    expect(onBackgroundTask).toHaveBeenCalledWith(task)
    await act(async () => buttons[1]!.click())
    expect(onStopTask).toHaveBeenCalledWith(task)
    await render([{ ...task, isBackgrounded: true }], { onBackgroundTask, onStopTask })
    expect([...pane().querySelectorAll<HTMLButtonElement>('.panel-subagent-actions button')]
      .map((button) => button.textContent)).toEqual(['停止'])
  })

  it('keeps a finished subagent briefly, then lets its head go', async () => {
    vi.useFakeTimers()
    await render([makeTask('t1', '快结束了')])
    expect(container!.querySelectorAll('.panel-subagent-icon')).toHaveLength(1)
    await render([makeTask('t1', '快结束了', { status: 'completed', endedAt: new Date().toISOString() })])
    expect(container!.querySelector('.panel-subagent-icon')?.className).toContain('is-completed')
    await act(async () => vi.advanceTimersByTime(5_000))
    expect(container!.querySelectorAll('.panel-subagent-icon')).toHaveLength(1)
    await act(async () => vi.advanceTimersByTime(1_500))
    expect(container!.querySelectorAll('.panel-subagent-icon')).toHaveLength(0)
  })
})
