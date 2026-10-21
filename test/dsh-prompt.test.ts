import { describe, expect, it } from 'vitest'
import { buildDshHostRules } from '../src/main/dsh-prompt'

describe('DSH 宿主规则', () => {
  it('联网开启时引导使用 DeepSeek 搜索，关闭时明确禁止', () => {
    const on = buildDshHostRules({ webSearchEnabled: true })
    expect(on).toContain('mcp__pet__deepseek_search')
    expect(on).not.toContain('当前已禁用联网搜索')

    const off = buildDshHostRules({ webSearchEnabled: false })
    expect(off).toContain('当前已禁用联网搜索')
    expect(off).not.toContain('优先使用 mcp__pet__deepseek_search')
  })

  it('始终要求命令写中文说明，并让模型用文字提问', () => {
    const rules = buildDshHostRules({ webSearchEnabled: true })
    expect(rules).toContain('description 字段必须用简短中文')
    expect(rules).toContain('直接用文字提问')
    expect(rules).toContain('不要调用 create_goal')
    expect(rules).toContain('每做完一小步')
  })

  it('输出风格和追加指令按需拼入', () => {
    expect(buildDshHostRules({ webSearchEnabled: true, outputStyle: 'Explanatory' }))
      .toContain('先解释原理与推理依据')
    expect(buildDshHostRules({ webSearchEnabled: true, outputStyle: 'Learning' }))
      .toContain('教学式引导回答')
    expect(buildDshHostRules({ webSearchEnabled: true, appendSystemPrompt: '只回答中文。' }))
      .toContain('只回答中文。')
    expect(buildDshHostRules({ webSearchEnabled: true })).not.toContain('先解释原理')
  })
})
