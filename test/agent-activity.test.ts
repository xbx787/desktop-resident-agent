import { describe, expect, it } from 'vitest'
import { agentActivityForTool } from '../src/shared/agent-activity'

describe('agent activity semantics', () => {
  it('maps DSH and MCP tools to stable portrait categories', () => {
    expect(agentActivityForTool('Read')).toBe('reading')
    expect(agentActivityForTool('apply_patch')).toBe('writing')
    expect(agentActivityForTool('pwsh')).toBe('terminal')
    expect(agentActivityForTool('mcp__deepseek__search')).toBe('searching')
    expect(agentActivityForTool('image_generate')).toBe('drawing')
    expect(agentActivityForTool('subagent_fork')).toBe('delegating')
  })

  it('distinguishes local lookup from remote search', () => {
    expect(agentActivityForTool('Grep', 'search')).toBe('reading')
    expect(agentActivityForTool('Glob', 'search')).toBe('reading')
    expect(agentActivityForTool('search_files', 'search')).toBe('reading')
    expect(agentActivityForTool('web_search', 'search')).toBe('searching')
  })

  it('prefers an adapter kind and keeps unknown tools honest', () => {
    expect(agentActivityForTool('custom_tool', 'read')).toBe('reading')
    expect(agentActivityForTool('Bash', 'read')).toBe('reading')
    expect(agentActivityForTool('custom_tool', 'execute')).toBe('terminal')
    expect(agentActivityForTool('custom_tool', 'edit')).toBe('writing')
    expect(agentActivityForTool('custom_tool')).toBe('other')
  })
})
