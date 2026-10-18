import { describe, expect, it } from 'vitest'
import { toolLabel } from '../src/shared/tool-labels'

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
    expect(toolLabel('EnterPlanMode')).toBe('进入计划模式')
    expect(toolLabel('ExitPlanMode')).toBe('提交计划')
    expect(toolLabel('ToolSearch')).toBe('查找工具')
    expect(toolLabel('Workflow')).toBe('编排工作流')
    expect(toolLabel('CronCreate')).toBe('新建定时任务')
    expect(toolLabel('ScheduleWakeup')).toBe('安排唤醒')
  })

  it('keeps names it has no word for — MCP tools above all', () => {
    expect(toolLabel('mcp__windows-mcp__click')).toBe('mcp__windows-mcp__click')
    expect(toolLabel('SomeFutureTool')).toBe('SomeFutureTool')
    expect(toolLabel('')).toBe('')
  })

  it('labels a missing tool name as a result, not "未知工具"', () => {
    expect(toolLabel('unknown_tool')).toBe('工具结果')
    expect(toolLabel('未知工具')).toBe('工具结果')
    expect(toolLabel('Graeme</broken>')).toBe('工具')
  })
})
