import { describe, expect, it } from 'vitest'
import { ClaudeStreamParser, claudeEnvironment } from '../src/main/claude-code'

describe('Claude Code stream adapter', () => {
  it('assembles split UTF-8 stream events and requires a successful final result', () => {
    const updates: string[] = []
    const parser = new ClaudeStreamParser((text) => updates.push(text))
    const data = Buffer.from([
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } }),
      JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '你好' })
    ].join('\n') + '\n')
    for (let index = 0; index < data.length; index += 3) parser.push(data.subarray(index, index + 3))
    expect(updates).toEqual(['你好'])
    expect(parser.finish()).toBe('你好')
  })

  it('does not mark an incomplete stream as successful', () => {
    const parser = new ClaudeStreamParser()
    parser.push(Buffer.from(JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '未完成' } } }) + '\n'))
    expect(() => parser.finish()).toThrow('没有返回最终结果')
  })

  it('overrides other provider credentials only for the child process', () => {
    const parent = { ANTHROPIC_API_KEY: 'other-provider-key', ANTHROPIC_BASE_URL: 'https://elsewhere.example', DEEPSEEK_API_KEY: 'user-key' }
    const child = claudeEnvironment(parent, 'deepseek-key')
    expect(child.ANTHROPIC_API_KEY).toBeUndefined()
    expect(child.ANTHROPIC_AUTH_TOKEN).toBe('deepseek-key')
    expect(child.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic')
    expect(parent.ANTHROPIC_BASE_URL).toBe('https://elsewhere.example')
  })
})
