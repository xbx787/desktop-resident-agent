import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskStrip, taskCounts } from '../src/renderer/task-strip'

const tasks = [
  { id: '1', subject: '改造时间线', status: 'in_progress' as const },
  { id: '2', subject: '写文档', status: 'completed' as const }
]

describe('taskCounts', () => {
  it('shows done over total as one compact fraction', () => {
    expect(taskCounts(tasks)).toEqual(['1/2'])
    expect(taskCounts([{ id: '1', subject: 'x', status: 'pending' }])).toEqual(['0/1'])
  })
})

describe('TaskStrip', () => {
  it('shows unfinished tasks right away, outside plan mode too', () => {
    // Unfinished tasks keep the little dashboard up on their own: no plan mode
    // required, no "fresh list just appeared" moment — a reopened conversation
    // shows it just the same.
    const html = renderToStaticMarkup(<TaskStrip tasks={tasks} planMode={false} />)
    expect(html).toContain('aria-label="任务列表"')
    expect(html).toContain('1/2')
  })

  it('shows the open plan while plan mode is on: summary, subjects, marks', () => {
    const html = renderToStaticMarkup(<TaskStrip tasks={tasks} planMode />)
    expect(html).toContain('aria-label="任务列表"')
    expect(html).toContain('aria-expanded="true"')
    expect(html).toContain('1/2')
    expect(html).toContain('class="panel-task is-in_progress"')
    expect(html).toContain('改造时间线')
    expect(html).toContain('✓')
  })

  it('folds the whole strip away once every task is completed', () => {
    const html = renderToStaticMarkup(<TaskStrip tasks={[{ id: '1', subject: '写文档', status: 'completed' }]} planMode />)
    expect(html).toBe('')
  })
})
