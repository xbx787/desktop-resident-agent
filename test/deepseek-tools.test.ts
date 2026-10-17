import { afterEach, describe, expect, it, vi } from 'vitest'
import { deepseekFetch, deepseekSearch, resolveDeepSeekToolsKey } from '../src/main/deepseek-tools'

describe('DeepSeek search/fetch tools', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('parses search hits and clamps the count into the API range', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      results: [{ title: 'A', url: 'https://a.example', snippet: 's', summary: 'm', date: '2026-01-01T00:00:00Z' }]
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const hits = await deepseekSearch('测试', 99, 'sk-test')
    expect(hits).toEqual([{ title: 'A', url: 'https://a.example', snippet: 's', summary: 'm', date: '2026-01-01T00:00:00Z' }])
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/v1/tools/search')
    expect(JSON.parse(String(init.body))).toMatchObject({ query: '测试', count: 10, need_content: false })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('returns empty results as an empty list, not an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })))
    expect(await deepseekSearch('没有结果', 5, 'sk-test')).toEqual([])
  })

  it('fetches markdown content and truncates overlong pages', async () => {
    const long = 'x'.repeat(300_000)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ title: 'T', content: long }), { status: 200 })))
    const page = await deepseekFetch('https://example.com', 'sk-test')
    expect(page.title).toBe('T')
    expect(page.content.length).toBeLessThan(long.length)
    expect(page.content).toContain('已截断')
  })

  it('surfaces HTTP failures with the status code so the model can react', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })))
    await expect(deepseekFetch('https://example.com', 'sk-test')).rejects.toThrow('HTTP 403')
  })

  it('prefers the official profile key and falls back to the environment key', () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'sk-env')
    expect(resolveDeepSeekToolsKey({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-profile' })).toBe('sk-profile')
    expect(resolveDeepSeekToolsKey({ baseUrl: 'http://127.0.0.1:22092', apiKey: 'local-token' })).toBe('sk-env')
    vi.stubEnv('DEEPSEEK_API_KEY', '')
    expect(resolveDeepSeekToolsKey({ baseUrl: 'http://127.0.0.1:22092', apiKey: 'local-token' })).toBeUndefined()
  })
})
