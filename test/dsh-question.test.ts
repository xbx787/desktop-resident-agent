import { describe, expect, it } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import type { AskQuestionRequest } from '../src/shared/contracts'

function createClient(answer: (sessionId: string, callId: string, batch: unknown[]) => Promise<boolean>) {
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
    answer
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
    dshHome: '.cache/tests/dsh-question',
    libraries: { mcp: {}, plugins: [] }
  })
}

describe('DSH 提问与作答', () => {
  it('把提问工具调用变成面板请求，回答按 DSH 的格式交回去', async () => {
    const calls: unknown[] = []
    const client = createClient(async (sessionId, callId, batch) => {
      calls.push([sessionId, callId, batch])
      return true
    })
    const seen: Array<AskQuestionRequest | null> = []
    client.setQuestionListener((request) => seen.push(request))

    const internal = client as unknown as {
      sessionId: string
      maybeStartQuestion: (callId: string, title: string, input: unknown) => void
    }
    internal.sessionId = 'session-1'
    internal.maybeStartQuestion('call-1', 'ask_user_question', {
      questions: [{
        id: 'q1',
        question: '选哪个方案',
        options: [{ label: '甲' }, { label: '乙', description: '更慢' }]
      }]
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      id: 'call-1',
      questions: [{ key: 'q1', question: '选哪个方案', multiSelect: false }]
    })

    await expect(client.answerQuestion('call-1', { q1: '甲' })).resolves.toBe(true)
    expect(calls).toEqual([['session-1', 'call-1', [{ id: 'q1', selected: ['甲'] }]]])
    expect(seen.at(-1)).toBeNull()
  })

  it('自由文本放到 custom，问题失效时返回 false', async () => {
    const calls: unknown[] = []
    const client = createClient(async (_sessionId, _callId, batch) => { calls.push(batch); return true })
    client.setQuestionListener(() => undefined)
    const internal = client as unknown as {
      sessionId: string
      maybeStartQuestion: (callId: string, title: string, input: unknown) => void
    }
    internal.sessionId = 'session-2'
    internal.maybeStartQuestion('call-2', 'ask_user_question', {
      questions: [{ id: 'q1', question: '写一句', options: [{ label: '甲' }] }]
    })
    await client.answerQuestion('call-2', { q1: '我自己写' })
    expect(calls).toEqual([[{ id: 'q1', selected: [], custom: '我自己写' }]])
    await expect(client.answerQuestion('call-2', { q1: '甲' })).resolves.toBe(false)
  })

  it('服务级提问（退出计划模式）走面板，回答直接交回并同步计划模式', async () => {
    const client = createClient(async () => true)
    const seen: Array<AskQuestionRequest | null> = []
    const planModes: boolean[] = []
    client.setQuestionListener((request) => seen.push(request))
    client.setPlanModeListener((on) => planModes.push(on))
    const internal = client as unknown as {
      handleServerRequest: (request: { method: string; params: Record<string, unknown> }) => Promise<unknown>
    }
    const pending = internal.handleServerRequest({
      method: 'session/question',
      params: { sessionId: 's', questions: [{ id: 'q1', question: '批准计划？', options: [{ label: '批准' }, { label: '拒绝' }] }] }
    })
    expect(seen).toHaveLength(1)
    const id = seen[0]!.id
    await expect(client.answerQuestion(id, { q1: '批准' })).resolves.toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['批准'] }] })
    expect(planModes).toEqual([false])
    expect(seen.at(-1)).toBeNull()
  })
})
