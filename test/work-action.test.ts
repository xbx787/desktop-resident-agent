import { describe, expect, it } from 'vitest'
import { workAction } from '../src/renderer/work-cluster'

describe('work header action', () => {
  it('names what the latest call did, with its object as the tail', () => {
    expect(workAction({ name: 'Edit', detail: 'src/renderer/panel.tsx' }))
      .toBe('编辑了文件 · src/renderer/panel.tsx')
    expect(workAction({ name: 'Write', detail: 'README.md' })).toBe('写入了文件 · README.md')
    expect(workAction({ name: 'Bash', detail: '列出目录' })).toBe('执行了命令 · 列出目录')
  })

  it('keeps a phrase-only line when the call carries no input', () => {
    expect(workAction({ name: 'Read', detail: '' })).toBe('读取了文件')
  })

  it('falls back to the Chinese tool label for tools it does not know', () => {
    expect(workAction({ name: 'TodoWrite', detail: '' })).toBe('执行了更新任务')
    expect(workAction({ name: 'mcp__windows__click', detail: '按钮' })).toBe('执行了mcp__windows__click · 按钮')
  })

  it('truncates a very long command into one readable line', () => {
    const text = workAction({ name: 'Bash', detail: 'x'.repeat(200) })
    expect(text.length).toBeLessThan(100)
    expect(text.endsWith('…')).toBe(true)
  })
})
