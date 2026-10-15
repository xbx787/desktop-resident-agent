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
    // 执行命令是一对分开的尖括号：左边一个尖朝左（<）、右边一个尖朝右（>）。
    // 两个根部要拉开距离——贴在一起会连成一个菱形（这里钉住两个根部的 x）。
    expect(bash).toContain('m7.6 5.2-3.6 4.8 3.6 4.8')
    expect(bash).toContain('m12.4 5.2 3.6 4.8-3.6 4.8')
    expect(bash).not.toContain('<rect')
    expect(renderToStaticMarkup(<ToolIcon name="Read" />)).not.toBe(bash)
    expect(renderToStaticMarkup(<ToolIcon name="BASH" />)).toBe(bash)
  })
})
