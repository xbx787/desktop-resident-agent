import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeepSeekClient } from '../src/main/deepseek'

afterEach(() => vi.unstubAllGlobals())

describe('DeepSeek Responses API adapter', () => {
  it('uses the current model ID and treats a tool call as a proposal', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '可以，先请你确认。' }] },
            { type: 'function_call', name: 'write_test_note', arguments: '{"title":"测试","content":"正文"}' }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
    vi.stubGlobal('fetch', mockFetch)

    const reply = await new DeepSeekClient('test-key').respond(
      [{ role: 'user', content: '写一条测试笔记' }],
      new AbortController().signal
    )
    expect(reply).toEqual({ text: '可以，先请你确认。', note: { title: '测试', content: '正文' } })
    const request = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(request.model).toBe('deepseek-flash')
    expect(request.tools).toHaveLength(1)
    expect(request.tools[0].name).toBe('write_test_note')
  })

  it('rejects unsupported or multiple tool calls without executing any action', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'completed',
            output: [
              { type: 'function_call', name: 'write_test_note', arguments: '{"title":"a","content":"b"}' },
              { type: 'function_call', name: 'write_test_note', arguments: '{"title":"c","content":"d"}' }
            ]
          }),
          { status: 200 }
        )
      )
    )
    await expect(
      new DeepSeekClient('test-key').respond([{ role: 'user', content: 'hi' }], new AbortController().signal)
    ).rejects.toThrow('多项操作')
  })

  it('keeps a frozen reference only while its user line remains inside the last 20 messages', async () => {
    const mockFetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({
      status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '收到' }] }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
    const client = new DeepSeekClient('test-key')
    const reference = { role: 'user' as const, content: '问题\n\n冻结的引用原文' }
    const filler = Array.from({ length: 19 }, (_, index) => ({
      role: index % 2 ? 'user' as const : 'assistant' as const,
      content: `消息 ${index}`
    }))
    await client.respond([reference, ...filler], new AbortController().signal)
    const within = JSON.parse(mockFetch.mock.calls[0][1].body as string)
    expect(within.input[0].content).toContain('冻结的引用原文')
    await client.respond([reference, ...filler, { role: 'user', content: '新的追问' }], new AbortController().signal)
    const outside = JSON.parse(mockFetch.mock.calls[1][1].body as string)
    expect(outside.input).toHaveLength(20)
    expect(JSON.stringify(outside.input)).not.toContain('冻结的引用原文')
  })
})
