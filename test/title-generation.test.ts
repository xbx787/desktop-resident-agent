import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanTitle, generateConversationTitle } from '../src/main/title-generation'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

function respondWith(body: unknown, ok = true, status = 200): void {
  globalThis.fetch = vi.fn(async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch
}

function messageOutput(text: string): unknown {
  return { output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
}

describe('cleanTitle', () => {
  it('strips quotes, prefixes and trailing punctuation', () => {
    expect(cleanTitle('「项目进度」')).toBe('项目进度')
    expect(cleanTitle('标题：修复登录问题')).toBe('修复登录问题')
    expect(cleanTitle('"Fix login bug."')).toBe('Fix login bug')
    expect(cleanTitle('「标题：文件整理」')).toBe('文件整理')
    expect(cleanTitle('换个说法《重构计划》。')).toBe('换个说法《重构计划》')
  })

  it('collapses whitespace, truncates long titles and rejects decoration-only output', () => {
    expect(cleanTitle('  多   空格   标题  ')).toBe('多 空格 标题')
    expect(cleanTitle('一'.repeat(50))).toBe('一'.repeat(32))
    expect(cleanTitle('「」')).toBeNull()
    expect(cleanTitle('   ')).toBeNull()
    expect(cleanTitle('。。。')).toBeNull()
  })
})

describe('generateConversationTitle', () => {
  it('asks DeepSeek once with thinking off and returns the cleaned title', async () => {
    respondWith(messageOutput('「整理项目文档」'))
    const title = await generateConversationTitle('test-key', '帮我把项目里的文档整理一下，先看看现在的结构。')
    expect(title).toBe('整理项目文档')
    const call = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.reasoning).toEqual({ effort: 'none' })
    expect(body.input[0].content).toContain('帮我把项目里的文档整理一下')
    expect((call[1] as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer test-key')
  })

  it('returns null without a request when there is nothing to title', async () => {
    respondWith(messageOutput('不会用到'))
    expect(await generateConversationTitle('test-key', '   ')).toBeNull()
    expect(globalThis.fetch).not.toHaveBeenCalled?.()
  })

  it('keeps every failure silent: HTTP errors, bad payloads and network faults', async () => {
    respondWith({}, false, 500)
    expect(await generateConversationTitle('test-key', '第一条消息')).toBeNull()
    respondWith({ output: [{ type: 'function_call', name: 'nope' }] })
    expect(await generateConversationTitle('test-key', '第一条消息')).toBeNull()
    respondWith(messageOutput('   '))
    expect(await generateConversationTitle('test-key', '第一条消息')).toBeNull()
    globalThis.fetch = vi.fn(async () => { throw new Error('network down') }) as unknown as typeof fetch
    expect(await generateConversationTitle('test-key', '第一条消息')).toBeNull()
    respondWith(messageOutput('标题'))
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json') } })) as unknown as typeof fetch
    expect(await generateConversationTitle('test-key', '第一条消息')).toBeNull()
  })
})
