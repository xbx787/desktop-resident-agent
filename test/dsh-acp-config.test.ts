import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import { setPersonaDirectory } from '../src/main/persona'
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
  compactResult: { shadowed?: number; tokens?: number } = { shadowed: 3, tokens: 1200 }
  usageResult: { used?: number; size?: number } = { used: 40_000, size: 100_000 }
  usageCalls = 0
  compactCalls = 0
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
  prompts: Array<{ sessionId: string; blocks: Array<{ type: string; text?: string }> }> = []
  promptScript: Array<() => void> = []
  private listeners = new Set<(notification: unknown) => void>()
  onNotification(listener: (notification: unknown) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(kind: string, update: Record<string, unknown>): void {
    for (const listener of [...this.listeners]) {
      listener({ method: 'session/update', params: { sessionId: 'session-1', update: { sessionUpdate: kind, ...update } } })
    }
  }

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

  async prompt(sessionId: string, blocks: Array<{ type: string; text?: string }>): Promise<{ stopReason: string }> {
    this.prompts.push({ sessionId, blocks })
    for (const step of this.promptScript) step()
    return { stopReason: 'end_turn' }
  }
  async compact(): Promise<{ shadowed?: number; tokens?: number }> {
    this.compactCalls += 1
    return this.compactResult
  }
  async usage(): Promise<{ used?: number; size?: number }> {
    this.usageCalls += 1
    return this.usageResult
  }
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

  it('把人设和宿主规则放在用户消息前面，因为 ACP 没有系统提示通道', async () => {
    const { client, runtime } = await create()
    await client.respond([{ role: 'user', content: '只回一个字：好' }], new AbortController().signal)
    const text = runtime.prompts[0]?.blocks[0]?.text ?? ''
    expect(text).toContain('你叫小鲸')
    expect(text).toContain('宿主说明')
    expect(text).toContain('只回一个字：好')
    expect(text.indexOf('你叫小鲸')).toBeLessThan(text.indexOf('只回一个字：好'))
  })

  it('每轮重读人设文件：改完下一轮就带上新文本', async () => {
    const { client, runtime, root } = await create()
    const directory = path.join(root, 'persona')
    await fs.mkdir(directory, { recursive: true })
    const file = path.join(directory, 'xiaojing.md')
    await fs.writeFile(file, '你是初版人设。', 'utf8')
    setPersonaDirectory(directory)
    try {
      await client.respond([{ role: 'user', content: '第一句' }], new AbortController().signal)
      await fs.writeFile(file, '你是改过的人设。', 'utf8')
      await client.respond([{ role: 'user', content: '第二句' }], new AbortController().signal)
    } finally {
      setPersonaDirectory(null)
    }
    expect(runtime.prompts[0]?.blocks[0]?.text).toContain('初版人设')
    expect(runtime.prompts[1]?.blocks[0]?.text).toContain('改过的人设')
  }, 20_000)

  it('最终回复只取最后一次工具调用之后的文字，不把整轮旁白拼成一段', async () => {
    const { client, runtime } = await create()
    runtime.promptScript = [
      () => runtime.emit('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: '先校准一次：' } }),
      () => runtime.emit('tool_call', { toolCallId: 't1', title: 'Move', rawInput: {} }),
      () => runtime.emit('tool_call_update', { toolCallId: 't1', status: 'completed' }),
      () => runtime.emit('agent_message_chunk', { messageId: 'm2', content: { type: 'text', text: '参数在下面。' } })
    ]
    const reply = await client.respond([{ role: 'user', content: '继续' }], new AbortController().signal)
    expect(reply.text).toBe('参数在下面。')
  })

  it('工具调用后没有新文字时，回退到最后一条旁白', async () => {
    const { client, runtime } = await create()
    runtime.promptScript = [
      () => runtime.emit('agent_message_chunk', { messageId: 'm1', content: { type: 'text', text: '已经改好。' } }),
      () => runtime.emit('tool_call', { toolCallId: 't1', title: 'Edit', rawInput: {} })
    ]
    const reply = await client.respond([{ role: 'user', content: '继续' }], new AbortController().signal)
    expect(reply.text).toBe('已经改好。')
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

  it('手动压缩后立即读取实时占用，返回压缩后的读数', async () => {
    const { client, runtime } = await create()
    await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
    runtime.usageResult = { used: 12_000, size: 100_000 }

    const usage = await client.compact()

    expect(runtime.compactCalls).toBe(1)
    expect(runtime.usageCalls).toBe(1)
    expect(usage).toMatchObject({
      status: 'available',
      usedTokens: 12_000,
      maxTokens: 100_000,
      usedPercent: 12,
      compactionOutcome: 'compacted'
    })
    await expect(client.getContextUsage()).resolves.toMatchObject({ usedTokens: 12_000 })
    expect(runtime.usageCalls).toBe(2)
  })
})
