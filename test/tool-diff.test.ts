import { describe, expect, it } from 'vitest'
import { toolDiffPreview } from '../src/renderer/tool-diff'

const statOf = (name: string, input: string | undefined) => {
  const preview = toolDiffPreview(name, input)
  return preview && { added: preview.added, removed: preview.removed }
}

describe('toolDiffPreview', () => {
  it('counts an edit as the changed lines, not the whole block, and keeps the lines', () => {
    const input = JSON.stringify({ file_path: 'src/a.ts', old_string: 'const a = 1\nconst b = 2\n', new_string: 'const a = 1\nconst b = 3\nconst c = 4\n' })
    expect(statOf('Edit', input)).toEqual({ added: 2, removed: 1 })
    expect(toolDiffPreview('Edit', input)?.lines).toEqual([
      { kind: 'context', text: 'const a = 1' },
      { kind: 'del', text: 'const b = 2' },
      { kind: 'add', text: 'const b = 3' },
      { kind: 'add', text: 'const c = 4' }
    ])
  })

  it('reports a pure insertion as added lines only', () => {
    const input = JSON.stringify({ old_string: 'a\nb', new_string: 'a\nx\ny\nb' })
    expect(statOf('Edit', input)).toEqual({ added: 2, removed: 0 })
    expect(toolDiffPreview('Edit', input)?.lines.filter((line) => line.kind === 'add').map((line) => line.text)).toEqual(['x', 'y'])
  })

  it('adds up every edit of a MultiEdit call and separates the blocks', () => {
    const input = JSON.stringify({ edits: [
      { old_string: 'a', new_string: 'a\nb' },
      { old_string: 'c\nd', new_string: 'c' }
    ] })
    expect(statOf('MultiEdit', input)).toEqual({ added: 1, removed: 1 })
    expect(toolDiffPreview('MultiEdit', input)?.lines.map((line) => line.kind)).toEqual(['context', 'add', 'gap', 'context', 'del'])
  })

  it('counts a whole-file write on the added side only', () => {
    expect(statOf('Write', JSON.stringify({ file_path: 'src/b.ts', content: 'one\ntwo\nthree\n' }))).toEqual({ added: 3, removed: 0 })
    expect(statOf('NotebookEdit', JSON.stringify({ new_source: 'x = 1\ny = 2' }))).toEqual({ added: 2, removed: 0 })
    expect(toolDiffPreview('Write', JSON.stringify({ content: 'one\n' }))?.lines).toEqual([{ kind: 'add', text: 'one' }])
  })

  it('stays silent for anything it cannot measure honestly', () => {
    expect(toolDiffPreview('Read', JSON.stringify({ file_path: 'src/a.ts' }))).toBeNull()
    expect(toolDiffPreview('Bash', JSON.stringify({ command: 'ls' }))).toBeNull()
    expect(toolDiffPreview('Write', JSON.stringify({ file_path: 'src/b.ts' }))).toBeNull()
    expect(toolDiffPreview('Edit', JSON.stringify({ replace_all: true }))).toBeNull()
    expect(toolDiffPreview('NotebookEdit', JSON.stringify({ new_source: '' }))).toBeNull()
    expect(toolDiffPreview('Edit', 'not json')).toBeNull()
    expect(toolDiffPreview('Edit', undefined)).toBeNull()
  })

  it('skips the diff table for oversized blocks instead of hanging', () => {
    const before = Array.from({ length: 600 }, (_, index) => `old ${index}`).join('\n')
    const after = Array.from({ length: 600 }, (_, index) => `new ${index}`).join('\n')
    expect(statOf('Edit', JSON.stringify({ old_string: before, new_string: after }))).toEqual({ added: 600, removed: 600 })
  })

  it('cuts a long diff down to the changed lines and says how many it hid', () => {
    const before = ['a', 'b', 'c', 'x', 'd'].join('\n')
    const after = ['a', 'b', 'c', 'y', 'd'].join('\n')
    const preview = toolDiffPreview('Edit', JSON.stringify({ old_string: before, new_string: after }), 2)!
    expect(preview.lines).toEqual([{ kind: 'del', text: 'x' }, { kind: 'add', text: 'y' }])
    expect(preview.hidden).toBe(4)
    expect({ added: preview.added, removed: preview.removed }).toEqual({ added: 1, removed: 1 })
  })

  it('keeps both counts whole even when the body is cut short', () => {
    const content = Array.from({ length: 500 }, (_, index) => `line ${index}`).join('\n')
    const preview = toolDiffPreview('Write', JSON.stringify({ content }))!
    expect(preview.added).toBe(500)
    expect(preview.lines).toHaveLength(200)
    expect(preview.hidden).toBe(300)
  })
})
