import { describe, expect, it, vi } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'

function createClient(steer: (sessionId: string, blocks: unknown[]) => Promise<{ queued: boolean; messageId?: string }>): DshAcpAgentClient {
  const runtime = {
    generation: 0,
    supportsImagePrompts: false,
    setRequestHandler(): void {},
    setSystemPrompt(): void {},
    setPermissionMode(): void {},
    onNotification(): () => void { return () => undefined },
    start: async () => undefined,
    close: async () => undefined,
    request: async () => ({}),
    steer
  }
  const bridge = {
    endpoint: null,
    webSearchEnabled: true,
    setDeepSeekApiKey(): void {},
    start: async () => ({ url: '', token: '' }),
    close: async () => undefined
  }
  return new DshAcpAgentClient({
    runtime: runtime as never,
    bridge: bridge as never,
    cwd: process.cwd(),
    dshHome: '.cache/tests/dsh-steer',
    libraries: { mcp: {}, plugins: [] }
  })
}

function markBusy(client: DshAcpAgentClient): void {
  const internal = client as unknown as { busy: boolean; sessionId: string }
  internal.busy = true
  internal.sessionId = 'session-1'
}

describe('DSH 原生插队', () => {
  it('走 session/steer，把文本交给正在跑的回合并带回 messageId', async () => {
    const calls: unknown[] = []
    const client = createClient(async (sessionId, blocks) => {
      calls.push([sessionId, blocks])
      return { queued: true, messageId: 'message-1' }
    })
    markBusy(client)
    await expect(client.steer('插一句')).resolves.toEqual({ accepted: true, messageId: 'message-1' })
    expect(calls).toEqual([['session-1', [{ type: 'text', text: '插一句' }]]])
  })

  it('运行时没有补丁时把异常抛给宿主，由宿主按“无法确认”处理', async () => {
    const client = createClient(async () => { throw new Error('method not found: session/steer') })
    markBusy(client)
    await expect(client.steer('插一句')).rejects.toThrow('method not found')
  })

  it('空闲时不发 steer 请求', async () => {
    let called = false
    const client = createClient(async () => { called = true; return { queued: true } })
    await expect(client.steer('插一句')).resolves.toEqual({ accepted: false })
    expect(called).toBe(false)
  })

  it('ACP 客户端真的发出 session/steer，并带回 DSH 的 messageId', async () => {
    const runtime = new DshAcpRuntime({
      bin: 'unused',
      home: '.cache/tests/dsh-steer-wire',
      cwd: process.cwd()
    })
    const request = vi.spyOn(runtime, 'request').mockResolvedValue({ queued: true, messageId: 'message-wire' })
    await expect(runtime.steer('session-wire', [{ type: 'text', text: '插一句' }]))
      .resolves.toEqual({ queued: true, messageId: 'message-wire' })
    expect(request).toHaveBeenCalledWith('session/steer', {
      sessionId: 'session-wire',
      prompt: [{ type: 'text', text: '插一句' }]
    }, 30_000)
  })
})
