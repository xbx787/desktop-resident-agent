import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverProviderModels } from '../src/main/model-discovery'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function serve(status: number, body: unknown): Promise<number> {
  const server = createServer((request, response) => {
    if (request.url !== '/anthropic/v1/models') {
      response.writeHead(404)
      response.end()
      return
    }
    response.writeHead(status, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  })
  servers.push(server)
  return await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })
}

describe('模型发现', () => {
  it('读取 Anthropic 风格的 data[].id，去重排序', async () => {
    const port = await serve(200, { data: [{ id: 'kimi-k3' }, { id: 'kimi-k2.5' }, { id: 'kimi-k3' }] })
    const result = await discoverProviderModels({ baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: 'k' })
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['kimi-k2.5', 'kimi-k3'])
  })

  it('也接受 models[] 和字符串数组', async () => {
    const port = await serve(200, { models: ['glm-4.6', 'glm-4.5'] })
    const result = await discoverProviderModels({ baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: 'k' })
    expect(result.ok).toBe(true)
    expect(result.models).toEqual(['glm-4.5', 'glm-4.6'])
  })

  it('鉴权失败和空列表给出可读提示，不抛异常', async () => {
    const port = await serve(401, {})
    const denied = await discoverProviderModels({ baseUrl: `http://127.0.0.1:${port}/anthropic`, apiKey: 'k' })
    expect(denied.ok).toBe(false)
    expect(denied.message).toContain('鉴权失败')
    expect(denied.models).toEqual([])
  })
})
