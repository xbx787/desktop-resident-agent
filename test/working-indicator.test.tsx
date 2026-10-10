import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkingIndicator, workingPhrase } from '../src/renderer/working-indicator'

describe('workingPhrase', () => {
  it('names what is happening in every gap the user would otherwise stare at', () => {
    expect(workingPhrase({ sending: true, thinking: false, status: 'idle' })).toBe('正在发送消息')
    expect(workingPhrase({ sending: false, thinking: true, status: 'executing' })).toBe('正在思考')
    expect(workingPhrase({ sending: false, thinking: false, status: 'planning' })).toBe('正在理解你的需求')
    expect(workingPhrase({ sending: false, thinking: false, status: 'executing', tool: 'Bash' })).toBe('正在执行命令')
    expect(workingPhrase({ sending: false, thinking: false, status: 'executing', tool: 'Read' })).toBe('正在读取')
    expect(workingPhrase({ sending: false, thinking: false, status: 'executing', tool: 'mcp__windows-mcp__click' })).toBe('正在执行 mcp__windows-mcp__click')
    expect(workingPhrase({ sending: false, thinking: false, status: 'executing' })).toBe('正在执行工具')
    expect(workingPhrase({ sending: false, thinking: false, status: 'verifying' })).toBe('正在整理结果')
  })

  it('stays silent when there is nothing to report', () => {
    expect(workingPhrase({ sending: false, thinking: false, status: 'idle' })).toBeNull()
    expect(workingPhrase({ sending: false, thinking: false, status: 'awaiting_approval' })).toBeNull()
    expect(workingPhrase({ sending: false, thinking: false, status: 'done' })).toBeNull()
  })
})

describe('WorkingIndicator', () => {
  it('renders the phrase and the animated dots, without the old interrupt hint', () => {
    const html = renderToStaticMarkup(<WorkingIndicator sending={false} thinking={false} status="executing" tool="Bash" />)
    expect(html).toContain('正在执行命令')
    expect(html).toContain('panel-working-dots')
    expect(html).not.toContain('Esc 可中断')
  })

  it('renders nothing while idle', () => {
    expect(renderToStaticMarkup(<WorkingIndicator sending={false} thinking={false} status="idle" />)).toBe('')
    expect(renderToStaticMarkup(<WorkingIndicator sending thinking={false} status="idle" />)).toContain('正在发送消息')
  })
})
