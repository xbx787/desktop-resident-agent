import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { workAction, workFacts, workFactsParts } from '../src/renderer/work-cluster'

describe('work header action', () => {
  it('names only the action, with no command text or colon', () => {
    expect(workAction({ name: 'Bash', detail: '列出目录' })).toBe('执行命令')
    expect(workAction({ name: 'Edit', detail: 'src/renderer/panel.tsx' })).toBe('编辑文件')
    expect(workAction({ name: 'Write', detail: 'README.md' })).toBe('写入文件')
    expect(workAction({ name: 'Read', detail: 'D:\\a\\very\\long\\file.tsx' })).toBe('读取文件')
  })

  it('keeps a phrase-only line when the command carries no input', () => {
    expect(workAction({ name: 'Bash', detail: '' })).toBe('执行命令')
  })

  it('falls back to the Chinese tool label for tools it does not know', () => {
    expect(workAction({ name: 'TodoWrite', detail: '' })).toBe('执行更新任务')
    expect(workAction({ name: 'mcp__windows__click', detail: '按钮' })).toBe('执行外部工具')
  })

  it('never adds a long command to the live line', () => {
    expect(workAction({ name: 'Bash', detail: 'x'.repeat(200) })).toBe('执行命令')
  })

  it('lists only the action names once the stretch has finished', () => {
    const tool = (id: string, name: string, input?: string): TimelineEntry => ({
      id, time: '2026-10-18T00:00:00.000Z', kind: 'tool', text: '',
      tool: { toolUseId: id, name, status: 'done', input }
    })
    const items = [
      tool('a', 'Bash', JSON.stringify({ description: '列出目录' })),
      tool('b', 'Edit', JSON.stringify({ file_path: 'src/renderer/panel.tsx' })),
      tool('c', 'Bash', JSON.stringify({ description: '跑测试' }))
    ]
    items[2].endedAt = '2026-10-18T00:00:10.000Z'
    const facts = workFacts(items, Date.parse('2026-10-18T00:00:10.000Z'), false)
    expect(workFactsParts(facts, false)).toEqual(['共 3 项操作'])
    expect(workFactsParts(facts, true)).toEqual(['共 3 项操作'])
  })
})
