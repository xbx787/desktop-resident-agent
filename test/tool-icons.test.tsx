import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolIcon, toolIconKind } from '../src/renderer/tool-icons'

describe('toolIconKind', () => {
  it('gives every family of Claude Code tool its own glyph', () => {
    expect(toolIconKind('Bash')).toBe('terminal')
    expect(toolIconKind('BashOutput')).toBe('terminal')
    expect(toolIconKind('KillShell')).toBe('terminal')
    expect(toolIconKind('Read')).toBe('document')
    expect(toolIconKind('Write')).toBe('document-write')
    expect(toolIconKind('Edit')).toBe('pencil')
    expect(toolIconKind('MultiEdit')).toBe('pencil')
    expect(toolIconKind('Grep')).toBe('search')
    expect(toolIconKind('Glob')).toBe('search')
    expect(toolIconKind('Task')).toBe('agent')
    expect(toolIconKind('TodoWrite')).toBe('checklist')
    expect(toolIconKind('WebFetch')).toBe('globe')
    expect(toolIconKind('WebSearch')).toBe('globe')
    expect(toolIconKind('NotebookEdit')).toBe('notebook')
    expect(toolIconKind('mcp__filesystem')).toBe('link')
  })

  it('falls back to a generic glyph for anything unknown', () => {
    expect(toolIconKind('SomethingElse')).toBe('gear')
    expect(toolIconKind('')).toBe('gear')
  })
})

describe('ToolIcon', () => {
  it('draws different shapes per family and ignores letter case', () => {
    const bash = renderToStaticMarkup(<ToolIcon name="Bash" />)
    expect(bash).toContain('panel-tool-icon')
    // 执行命令是一对尖括号：左边一个尖朝左（<）、右边一个尖朝右（>），
    // 不再有终端窗口的外框——方向反了会拼成一个叉，这里钉住朝向。
    expect(bash).toContain('m10.6 5.8-4.4 4.4 4.4 4.4')
    expect(bash).toContain('m9.4 5.8 4.4 4.4-4.4 4.4')
    expect(bash).not.toContain('<rect')
    expect(renderToStaticMarkup(<ToolIcon name="Read" />)).not.toBe(bash)
    expect(renderToStaticMarkup(<ToolIcon name="BASH" />)).toBe(bash)
  })
})
