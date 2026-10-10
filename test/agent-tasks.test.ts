import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { agentTasks } from '../src/renderer/agent-tasks'

let seq = 0
const tool = (name: string, input: unknown, output?: string, status: 'running' | 'done' | 'error' = 'done'): TimelineEntry =>
  ({ id: `e${seq++}`, kind: 'tool', text: name, time: '2026-10-09T00:00:00.000Z', tool: { toolUseId: 't', name, status, input: JSON.stringify(input), output } })
const create = (subject: string, id: number) => tool('TaskCreate', { subject, description: '说明' }, `Task #${id} created successfully: ${subject}`)
const update = (taskId: string, patch: Record<string, unknown>) => tool('TaskUpdate', { taskId, ...patch }, 'Updated task')

describe('agentTasks', () => {
  it('tracks created, started and finished tasks across the conversation', () => {
    const entries = [create('改造时间线', 1), create('写文档', 2), update('1', { status: 'in_progress' }), update('1', { status: 'completed' })]
    expect(agentTasks(entries)).toEqual([
      { id: '1', subject: '改造时间线', status: 'completed' },
      { id: '2', subject: '写文档', status: 'pending' }
    ])
  })

  it('takes the whole list from TodoWrite, replacing earlier tasks', () => {
    const entries = [
      create('旧任务', 1),
      tool('TodoWrite', { todos: [{ content: '分组思考', status: 'completed' }, { content: '做折叠段', status: 'in_progress' }] }),
      tool('TodoWrite', { todos: [{ content: '做折叠段', status: 'completed' }] })
    ]
    expect(agentTasks(entries)).toEqual([{ id: 'todo-0', subject: '做折叠段', status: 'completed' }])
  })

  it('removes a deleted task and renames a renamed one', () => {
    const entries = [create('旧名字', 1), create('另一个', 2), update('1', { subject: '新名字' }), update('2', { status: 'deleted' })]
    expect(agentTasks(entries)).toEqual([{ id: '1', subject: '新名字', status: 'pending' }])
  })

  it('ignores running calls, unrelated tools, unknown ids and broken input', () => {
    const entries = [
      tool('Bash', { command: 'npm test' }, 'ok'),
      tool('TaskCreate', { subject: '还没跑完' }, undefined, 'running'),
      update('99', { status: 'completed' }),
      tool('TaskCreate', {}, 'Task #3 created successfully:'),
      { id: 'broken', kind: 'tool', text: 'TaskCreate', time: '2026-10-09T00:00:00.000Z', tool: { toolUseId: 't', name: 'TaskCreate', status: 'done', input: 'not json' } } as TimelineEntry
    ]
    expect(agentTasks(entries)).toEqual([])
  })

  it('still lists a task when the result text carried no number', () => {
    expect(agentTasks([tool('TaskCreate', { subject: '没有编号' }, '什么也没说')])).toEqual([{ id: 'new-0', subject: '没有编号', status: 'pending' }])
  })
})
