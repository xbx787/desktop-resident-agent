import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import type { DshAcpRuntime } from '../src/main/dsh-acp-runtime'
import type { PetMcpBridge } from '../src/main/pet-mcp-server'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
  }
})

interface Request { method: string; params: Record<string, unknown> }

class FakeRuntime {
  generation = 1
  requests: Request[] = []
  failModelSet = false
  ignoreModelSet = false
  configOptions: Array<Record<string, unknown>> = [
    { id: 'model', name: 'Model', currentValue: JSON.stringify(['deepseek-official', 'deepseek-v4-flash']), options: [] },
    { id: 'reasoning_effort', name: 'Reasoning effort', currentValue: '', options: [{ value: '' }, { value: 'high' }] }
  ]

  get supportsImagePrompts(): boolean { return true }
  setRequestHandler(): void {}
  setSystemPrompt(): void {}
  permissionModes: string[] = []
  setPermissionMode(mode: string): void { this.permissionModes.push(mode) }
  async start(): Promise<void> {}
  async newSession(): Promise<{ sessionId: string }> { return { sessionId: 'session-1' } }
  async resumeSession(sessionId: string): Promise<{ sessionId: string }> { return { sessionId } }
  onNotification(): () => void { return () => undefined }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    this.requests.push({ method, params })
    if (method !== 'session/set_config_option') return {}
    if (params.configId === 'model') {
      if (this.failModelSet) throw new Error('unknown model option: ["deepseek-official","deepseek-flash[1m]"]')
      if (!this.ignoreModelSet) {
        this.configOptions = this.configOptions.map((option) =>
          option.id === 'model' ? { ...option, currentValue: params.value } : option)
      }
    }
    return { configOptions: this.configOptions }
  }

  async prompt(): Promise<{ stopReason: string }> { return { stopReason: 'end_turn' } }
  async setPlan(): Promise<boolean> { return true }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

class FakeBridge {
  setDeepSeekApiKey(): void {}
  async start(): Promise<void> {}
  async close(): Promise<void> {}
}

async function create(model?: string) {
  const root = path.join(process.cwd(), '.cache', 'tests', `dsh-acp-config-${randomUUID()}`)
  roots.push(root)
  await fs.mkdir(path.join(root, 'profiles', 'acp'), { recursive: true })
  await fs.writeFile(path.join(root, 'profiles', 'acp', 'package.json'), '{}\n', 'utf8')
  const runtime = new FakeRuntime()
  const client = new DshAcpAgentClient({
    runtime: runtime as unknown as DshAcpRuntime,
    bridge: new FakeBridge() as unknown as PetMcpBridge,
    cwd: root,
    dshHome: root,
    model
  })
  return { client, runtime, root }
}

describe('DSH ACP 会话模型设置', () => {
  it('把 deepseek-flash[1m] 规范化后再交给 ACP，并确认 currentValue', async () => {
    const { client, runtime, root } = await create('deepseek-flash[1m]')
    const reply = await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
    expect(reply.sdkSessionId).toBe('session-1')

    const setModel = runtime.requests.find((request) =>
      request.method === 'session/set_config_option' && request.params.configId === 'model')
    expect(setModel?.params.value).toBe(JSON.stringify(['deepseek-official', 'deepseek-flash']))

    const profile = await fs.readFile(path.join(root, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8')
    expect(profile).toContain('model: deepseek-flash')
  })

  it('运行中 setProvider 收到 deepseek-flash[1m] 也会规范化后再写 DSH 配置', async () => {
    const { client, runtime, root } = await create()
    client.setProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'test-key',
      model: 'deepseek-flash[1m]'
    })
    const reply = await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
    expect(reply.sdkSessionId).toBe('session-1')

    const setModel = runtime.requests.find((request) =>
      request.method === 'session/set_config_option' && request.params.configId === 'model')
    expect(setModel?.params.value).toBe(JSON.stringify(['deepseek-official', 'deepseek-flash']))

    const profile = await fs.readFile(path.join(root, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8')
    expect(profile).toContain('model: deepseek-flash')
    expect(profile).not.toContain('[1m]')
  })

  it('模型设置被 ACP 拒绝时报中文错误，不再静默继续', async () => {
    const { client, runtime } = await create()
    runtime.failModelSet = true
    await expect(client.respond([{ role: 'user', content: '你好' }], new AbortController().signal))
      .rejects.toThrow(/会话模型切换失败.*unknown model option/u)
  })

  it('设置后 currentValue 没有变化时报错，不假装成功', async () => {
    const { client, runtime } = await create()
    runtime.ignoreModelSet = true
    await expect(client.respond([{ role: 'user', content: '你好' }], new AbortController().signal))
      .rejects.toThrow(/DSH 没有接受模型设置/u)
  })

  it('模型声明推理档位时把 max 映射成 high', async () => {
    const { client, runtime } = await create()
    await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
    const effort = runtime.requests.find((request) =>
      request.method === 'session/set_config_option' && request.params.configId === 'reasoning_effort')
    expect(effort?.params.value).toBe('high')
  })

  it('切换审批模式只更新状态，下一次发消息前才换权限', async () => {
    const { client, runtime } = await create()
    client.setApprovalMode('selfEvolve')
    expect(runtime.permissionModes).toEqual([])
    await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
    expect(runtime.permissionModes).toContain('danger-full-access')
  })
})
