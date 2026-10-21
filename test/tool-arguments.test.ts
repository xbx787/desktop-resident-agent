import { describe, expect, it } from 'vitest'
import { toolArgumentDetails, toolArgumentPreview, toolPlanText } from '../src/renderer/tool-arguments'

describe('toolArgumentPreview', () => {
  it('picks the field that names the object of the call', () => {
    // 带 description 的命令显示描述（放在「执行命令」四个字后面更清楚），
    // 没有 description 的调用仍回退到命令本身。
    expect(toolArgumentPreview('{"command":"npm test","description":"跑测试"}')).toBe('跑测试')
    expect(toolArgumentPreview('{"command":"npm test"}')).toBe('npm test')
    expect(toolArgumentPreview('{"file_path":"D:\\\\DesktopPetProject\\\\src\\\\main\\\\index.ts"}')).toBe('D:\\DesktopPetProject\\src\\main\\index.ts')
    expect(toolArgumentPreview('{"pattern":"panel-live-label","path":"src"}')).toBe('panel-live-label')
    expect(toolArgumentPreview('{"url":"https://example.com/a"}')).toBe('https://example.com/a')
  })

  it('shows the description even when the model wrote it in English', () => {
    expect(toolArgumentPreview('{"command":"npm test","description":"run tests"}')).toBe('run tests')
    expect(toolArgumentPreview('{"command":"npm test","description":"Run the full test suite"}')).toBe('Run the full test suite')
  })

  it('falls back to another string field, then to the raw text', () => {
    expect(toolArgumentPreview('{"unknown":"值"}')).toBe('值')
    expect(toolArgumentPreview('{"list":[1,2]}')).toBe('{"list":[1,2]}')
    expect(toolArgumentPreview('npm run build')).toBe('npm run build')
  })

  it('flattens multi-line input into one line and handles nothing at all', () => {
    expect(toolArgumentPreview('{"command":"cd src\\nls -la\\n"}')).toBe('cd src ls -la')
    expect(toolArgumentPreview('{"command":"   "}')).toBe('')
    expect(toolArgumentPreview(undefined)).toBe('')
    expect(toolArgumentPreview('')).toBe('')
  })

  it('previews the plan itself, not just the file fields', () => {
    expect(toolArgumentPreview('{"plan":"1. 先看日志\\n2. 再改代码"}')).toBe('1. 先看日志 2. 再改代码')
  })
})

describe('toolArgumentDetails', () => {
  it('keeps every input field and line break in the expanded view', () => {
    expect(toolArgumentDetails('{"command":"cd src\\nls -la","description":"查看源码"}'))
      .toBe('{\n  "command": "cd src\\nls -la",\n  "description": "查看源码"\n}')
    expect(toolArgumentDetails('first\nsecond')).toBe('first\nsecond')
    expect(toolArgumentDetails(undefined)).toBe('')
  })
})

describe('toolPlanText', () => {
  it('returns the plan of an ExitPlanMode call, on any casing', () => {
    expect(toolPlanText('ExitPlanMode', '{"plan":"第一步：读代码\\n第二步：改配置"}')).toBe('第一步：读代码\n第二步：改配置')
    expect(toolPlanText('exitplanmode', '{"plan":"  "}')).toBe('')
  })

  it('stays quiet for other tools, missing or broken input', () => {
    expect(toolPlanText('Bash', '{"plan":"不该出现"}')).toBe('')
    expect(toolPlanText('ExitPlanMode', undefined)).toBe('')
    expect(toolPlanText('ExitPlanMode', 'not json')).toBe('')
  })
})
