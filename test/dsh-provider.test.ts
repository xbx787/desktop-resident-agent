import { describe, expect, it, vi } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'

function createClient(baseUrl?: string) {
  const environment: Array<{ apiKey?: string; baseUrl?: string }> = []
  const close = vi.fn(async () => undefined)
  const runtime = {
    generation: 0,
    supportsImagePrompts: false,
    setRequestHandler(): void {},
    setSystemPrompt(): void {},
    setPermissionMode(): void {},
    setDeepSeekEnvironment(patch: { apiKey?: string; baseUrl?: string }): void { environment.push(patch) },
    onNotification(): () => void { return () => undefined },
    start: async () => undefined,
    close,
    request: async () => ({}),
    cancel: async () => undefined
  }
  const bridge = {
    endpoint: null,
    webSearchEnabled: true,
    setDeepSeekApiKey(): void {},
    start: async () => ({ url: '', token: '' }),
    close: async () => undefined
  }
  return {
    client: new DshAcpAgentClient({
      runtime: runtime as never,
      bridge: bridge as never,
      cwd: process.cwd(),
      dshHome: '.cache/tests/dsh-provider',
      baseUrl,
      deepseekApiKey: 'launch-key',
      libraries: { mcp: {}, plugins: [] }
    }),
    environment,
    close
  }
}

describe('DSH 供应商地址', () => {
  it('构造时把 baseUrl 写进 DSH 进程环境', () => {
    const { environment } = createClient('http://127.0.0.1:8787')
    expect(environment).toEqual([{ apiKey: 'launch-key', baseUrl: 'http://127.0.0.1:8787' }])
  })

  it('切换地址时更新环境并重建进程，地址没变则不重启', () => {
    const { client, environment, close } = createClient('http://127.0.0.1:8787')
    client.setProvider({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'next-key', model: 'deepseek-flash' })
    expect(environment.at(-1)).toEqual({ apiKey: 'next-key', baseUrl: 'https://api.deepseek.com/anthropic' })
    expect(close).toHaveBeenCalledTimes(1)
    client.setProvider({ baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'next-key', model: 'deepseek-flash' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('清空地址时删掉 DEEPSEEK_BASE_URL，回到 DSH 默认官方端点', () => {
    const { client, environment } = createClient('http://127.0.0.1:8787')
    client.setProvider({ baseUrl: '', apiKey: 'next-key', model: 'deepseek-flash' })
    expect(environment.at(-1)).toEqual({ apiKey: 'next-key', baseUrl: '' })
  })
})
