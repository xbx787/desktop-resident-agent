// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { TaskStrip } from '../src/renderer/task-strip'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const tasks = [
  { id: '1', subject: '改造时间线', status: 'in_progress' as const },
  { id: '2', subject: '写文档', status: 'completed' as const }
]

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

describe('TaskStrip lifecycle', () => {
  it('shows up the moment a fresh task list appears', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<TaskStrip tasks={[]} planMode={false} />))
    expect(container.querySelector('.panel-tasks')).toBeNull()
    // A fresh task list appears mid-conversation: the strip shows up, expanded.
    await act(async () => root!.render(<TaskStrip tasks={tasks} planMode={false} />))
    expect(container.querySelector('.panel-tasks')).not.toBeNull()
    expect(container.querySelector('.panel-tasks-summary')?.getAttribute('aria-expanded')).toBe('true')
  })

  it('stays up while tasks are unfinished, across plan mode switches', async () => {
    // Reopening a conversation that still has unfinished tasks: the window is
    // already there, expanded.
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<TaskStrip tasks={tasks} planMode={false} />))
    expect(container.querySelector('.panel-tasks')).not.toBeNull()
    expect(container.querySelector('.panel-tasks-summary')?.getAttribute('aria-expanded')).toBe('true')
    // Plan mode toggles no longer wipe it — it answers to task state alone.
    await act(async () => root!.render(<TaskStrip tasks={tasks} planMode />))
    expect(container.querySelector('.panel-tasks')).not.toBeNull()
    await act(async () => root!.render(<TaskStrip tasks={tasks} planMode={false} />))
    expect(container.querySelector('.panel-tasks')).not.toBeNull()
  })
})
