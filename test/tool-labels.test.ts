import { describe, expect, it } from 'vitest'
import { mcpToolRef, toolLabel } from '../src/shared/tool-labels'

describe('toolLabel', () => {
  it('names the everyday tools in Chinese', () => {
    expect(toolLabel('Read')).toBe('读取')
    expect(toolLabel('Write')).toBe('写入')
    expect(toolLabel('Edit')).toBe('编辑')
    expect(toolLabel('MultiEdit')).toBe('批量编辑')
    expect(toolLabel('Bash')).toBe('执行命令')
    expect(toolLabel('Grep')).toBe('搜索')
    expect(toolLabel('Glob')).toBe('查找文件')
  })

  it('matches regardless of the casing the CLI reports', () => {
    expect(toolLabel('read')).toBe('读取')
    expect(toolLabel(' bash ')).toBe('执行命令')
  })

  it('covers the newer CLI tools too, Search and the mode switches included', () => {
    expect(toolLabel('Search')).toBe('搜索')
    expect(toolLabel('EnterPlanMode')).toBe('进入计划')
    expect(toolLabel('ExitPlanMode')).toBe('提交计划')
    expect(toolLabel('ToolSearch')).toBe('查找工具')
    expect(toolLabel('Workflow')).toBe('工作流')
    expect(toolLabel('CronCreate')).toBe('新建定时')
    expect(toolLabel('ScheduleWakeup')).toBe('安排唤醒')
  })

  it('labels the DSH first-party tools too, underscores and all', () => {
    expect(toolLabel('pwsh')).toBe('执行命令')
    expect(toolLabel('read_image')).toBe('读取图片')
    expect(toolLabel('job_output')).toBe('读取输出')
    expect(toolLabel('todo_write')).toBe('更新任务')
    expect(toolLabel('subagent')).toBe('子代理')
    expect(toolLabel('subagent_fork')).toBe('子代理')
    expect(toolLabel('ask_user_question')).toBe('向你提问')
    expect(toolLabel('web_search')).toBe('联网搜索')
    expect(toolLabel('list_agents')).toBe('列出代理')
  })

  it('classifies unknown names instead of leaking English identifiers', () => {
    expect(toolLabel('mcp__windows-mcp__click')).toBe('外部工具')
    expect(toolLabel('mcp__acme__search_docs')).toBe('搜索')
    expect(toolLabel('SomeFutureTool')).toBe('工具')
    expect(toolLabel('read_something')).toBe('读取')
    expect(toolLabel('list_items')).toBe('列出')
    expect(toolLabel('')).toBe('')
  })

  it('keeps every label within four Chinese characters', () => {
    for (const name of ['Read', 'Bash', 'Workflow', 'get_goal', 'ask_user_question', 'mcp__x__y', 'SomeFutureTool']) {
      expect(Array.from(toolLabel(name)).length).toBeLessThanOrEqual(4)
    }
  })

  it('labels a missing tool name as a result, not "未知工具"', () => {
    expect(toolLabel('unknown_tool')).toBe('工具结果')
    expect(toolLabel('未知工具')).toBe('工具结果')
    expect(toolLabel('Graeme</broken>')).toBe('工具')
  })
})


describe('mcpToolRef', () => {
  it('splits the Claude mcp__server__tool form', () => {
    expect(mcpToolRef('mcp__windows-mcp__Move')).toEqual({ server: 'windows-mcp', tool: 'Move' })
    expect(mcpToolRef('mcp__dida365__add_task')).toEqual({ server: 'dida365', tool: 'add_task' })
  })

  it('splits the DSH mcp:server:tool form', () => {
    expect(mcpToolRef('mcp:windows-mcp:Move')).toEqual({ server: 'windows-mcp', tool: 'Move' })
  })

  it('leaves ordinary tools alone', () => {
    expect(mcpToolRef('Read')).toBeNull()
    expect(mcpToolRef('mcp__broken')).toBeNull()
  })
})
