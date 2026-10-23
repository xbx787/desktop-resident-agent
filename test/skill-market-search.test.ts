import { afterEach, describe, expect, it, vi } from 'vitest'
import { searchMarket } from '../src/main/marketplace'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('多来源技能市场', () => {
  it('只请求已启用的来源，并保留 repo/subdir 供安装', async () => {
    const fetch = vi.fn(async (input: string | URL) => {
      const url = String(input)
      expect(url).toContain('api.github.com/repos/obra/superpowers/contents/skills')
      return new Response(JSON.stringify([
        { name: 'brainstorming', type: 'dir' },
        { name: 'writing-plans', type: 'dir' }
      ]), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetch)
    const items = await searchMarket('skill', 'brain', ['superpowers'])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: 'brainstorming',
      source: 'superpowers',
      repo: 'obra/superpowers',
      ref: 'main',
      subdir: 'skills/brainstorming'
    })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('全部来源关闭时不发网络请求', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(searchMarket('skill', 'brain', [])).resolves.toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
