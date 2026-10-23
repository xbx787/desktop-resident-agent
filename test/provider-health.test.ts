import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { OFFICIAL_ANTHROPIC_BASE_URL, probeProviderHealth } from '../src/main/provider-health'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

function listen(): Promise<number> {
  const server = createServer((_request, response) => {
    response.writeHead(204)
    response.end()
  })
  servers.push(server)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      resolve(address.port)
    })
  })
}

describe('供应商地址健康检查', () => {
  it('本地代理活着时返回可连接', async () => {
    const port = await listen()
    const result = await probeProviderHealth(`http://127.0.0.1:${port}`)
    expect(result.ok).toBe(true)
    expect(result.localProxy).toBe(true)
    expect(result.kind).toBe('ok')
  })

  it('本地代理没启动时明确指向代理失效，并给出官方地址', async () => {
    const port = await listen()
    // 先关掉再探测，拿到真实的 ECONNREFUSED。
    await new Promise<void>((resolve) => servers.pop()!.close(() => resolve()))
    const result = await probeProviderHealth(`http://127.0.0.1:${port}`, 1_000)
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('connection-refused')
    expect(result.localProxy).toBe(true)
    expect(result.message).toContain('本地代理拒绝连接')
    expect(result.message).toContain('没有在运行')
    expect(result.officialUrl).toBe(OFFICIAL_ANTHROPIC_BASE_URL)
  })

  it('官方地址一定是可切回的 Anthropic 兼容地址', async () => {
    const result = await probeProviderHealth('not-a-url')
    expect(result.ok).toBe(false)
    expect(result.kind).toBe('invalid-url')
    expect(result.officialUrl).toBe('https://api.deepseek.com/anthropic')
  })
})
