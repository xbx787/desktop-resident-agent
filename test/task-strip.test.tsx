import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { TaskStrip, planSteps, taskCounts } from '../src/renderer/task-strip'

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

describe('approved plan fallback', () => {
  it('parses numbered and bulleted plan steps', () => {
    expect(planSteps('1. 改配置\n2) 跑测试\n- 写文档\n* **收尾**')).toEqual([
      { id: 'plan-0', subject: '改配置', status: 'pending' },
      { id: 'plan-1', subject: '跑测试', status: 'pending' },
      { id: 'plan-2', subject: '写文档', status: 'pending' },
      { id: 'plan-3', subject: '收尾', status: 'pending' }
    ])
    expect(planSteps('没有步骤的一段说明')).toEqual([])
    expect(planSteps(undefined)).toEqual([])
  })

  it('shows the approved plan until the model creates real tasks', () => {
    const html = renderToStaticMarkup(<TaskStrip tasks={[]} planMode={false} planSummary={'1. 改配置\n2. 跑测试'} />)
    expect(html).toContain('aria-label="任务列表"')
    expect(html).toContain('0/2')
    expect(html).toContain('改配置')
    expect(html).toContain('跑测试')
  })

  it('does not resurrect plan steps after real tasks finish', () => {
    const html = renderToStaticMarkup(<TaskStrip tasks={[{ id: '1', subject: '写文档', status: 'completed' }]}
      planMode={false} planSummary={'1. 改配置'} />)
    expect(html).toBe('')
  })
})
