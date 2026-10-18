import { afterEach, describe, expect, it, vi } from 'vitest'

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('market adapters', () => {
  it('maps the MCP registry, skill catalog, and plugin catalog into one shape', async () => {
    const { searchMarket } = await import('../src/main/marketplace')
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes('registry.modelcontextprotocol.io')) {
        return json({
          servers: [{
            server: {
              name: 'io.github.demo/files', description: '文件服务', version: '1.2.3',
              packages: [{
                registryType: 'npm', identifier: '@demo/files', version: '1.2.3',
                transport: { type: 'stdio' }, environmentVariables: [{ name: 'ROOT' }]
              }]
            }
          }]
        })
      }
      if (url.includes('repos/anthropics/skills/contents/skills')) {
        return json([
          { name: 'pdf', type: 'dir' },
          { name: 'webapp-testing', type: 'dir' },
          { name: 'README.md', type: 'file' }
        ])
      }
      if (url.includes('claude-plugins-official')) {
        return json({
          plugins: [
            { name: 'review', description: '代码审查', version: '0.1.0', source: './plugins/review' },
            { name: 'external', description: '外部插件', source: { source: 'github', repo: 'demo/plugin', path: 'pkg', ref: 'main' } }
          ]
        })
      }
      throw new Error(`unexpected url ${url}`)
    }))

    const mcp = await searchMarket('mcp', '')
    expect(mcp).toMatchObject([{
      id: 'io.github.demo/files', kind: 'mcp', name: 'files',
      launch: { type: 'mcp', command: 'npx', args: ['-y', '@demo/files@1.2.3'], env: ['ROOT'] }
    }])

    const skills = await searchMarket('skill', 'pdf')
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({
      id: 'anthropics/pdf', kind: 'skill', license: 'source-available',
      repo: 'anthropics/skills', subdir: 'skills/pdf'
    })

    const plugins = await searchMarket('plugin', '')
    expect(plugins.map((item) => item.name)).toEqual(['review', 'external'])
    expect(plugins[0]).toMatchObject({ repo: 'anthropics/claude-plugins-official', subdir: 'plugins/review' })
    expect(plugins[1]).toMatchObject({ repo: 'demo/plugin', subdir: 'pkg', ref: 'main' })
  })

  it('turns a failed fetch into a readable retry message', async () => {
    const { searchMarket } = await import('../src/main/marketplace')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    await expect(searchMarket('mcp', 'anything')).rejects.toThrow('市场暂时连不上（503）')
  })
})
