import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import type { SubagentTask } from '../src/shared/contracts'

const root = path.join(process.cwd(), '.cache', 'tests', `dsh-subagent-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

function createClient(): DshAcpAgentClient {
  const runtime = {
    generation: 0,
    setRequestHandler(): void {},
    setSystemPrompt(): void {},
    setPermissionMode(): void {},
    onNotification(): () => void { return () => undefined },
    start: async () => undefined,
    close: async () => undefined,
    request: async () => ({})
  }
  const bridge = {
    endpoint: { url: 'http://127.0.0.1:1', token: 't' },
    webSearchEnabled: true,
    setDeepSeekApiKey(): void {},
    start: async () => ({ url: 'http://127.0.0.1:1', token: 't' }),
    close: async () => undefined
  }
  return new DshAcpAgentClient({
    runtime: runtime as never,
    bridge: bridge as never,
    cwd: process.cwd(),
    dshHome: root,
    libraries: { mcp: {}, plugins: [] }
  })
}

describe('DSH 子代理托盘', () => {
  it('把子代理工具调用记成任务，结束时给出状态和用时', () => {
    const client = createClient()
    const snapshots: SubagentTask[][] = []
    client.setSubagentTasksListener((tasks) => snapshots.push(tasks))

    const privateClient = client as unknown as {
      startSubagentTask: (id: string, title: string, input: unknown) => void
      finishSubagentTask: (id: string, failed: boolean, output: string) => void
    }
    privateClient.startSubagentTask('call-1', 'subagent', { prompt: '整理资料并给出结论' })
    expect(snapshots.at(-1)).toHaveLength(1)
    expect(snapshots.at(-1)![0]).toMatchObject({
      taskId: 'call-1',
      description: '整理资料并给出结论',
      status: 'running'
    })

    privateClient.finishSubagentTask('call-1', false, '结论是可用')
    const finished = snapshots.at(-1)![0]
    expect(finished.status).toBe('completed')
    expect(finished.summary).toBe('结论是可用')
    expect(typeof finished.durationMs).toBe('number')
  })

  it('把子会话里的工具事件挂到对应托盘任务的步骤里', () => {
    const client = createClient()
    const snapshots: SubagentTask[] = []
    client.setSubagentTasksListener((tasks) => { snapshots.splice(0, snapshots.length, ...tasks) })
    const privateClient = client as unknown as {
      startSubagentTask: (id: string, title: string, input: unknown) => void
      handleSubagentEvent: (params: Record<string, unknown>, sessionId: string) => void
    }
    privateClient.startSubagentTask('call-1', 'subagent', { prompt: '整理资料' })

    privateClient.handleSubagentEvent({
      sessionId: 's1', parentCallId: 'call-1', phase: 'start',
      callId: 't1', toolName: 'pwsh', input: { command: 'dir' }
    }, 's1')
    expect(snapshots[0].timeline).toHaveLength(1)
    expect(snapshots[0].timeline![0].text).toBe('执行命令（执行中）')

    privateClient.handleSubagentEvent({
      sessionId: 's1', parentCallId: 'call-1', phase: 'result',
      callId: 't1', toolName: 'pwsh', output: [{ type: 'text', text: '完成' }], isError: false
    }, 's1')
    expect(snapshots[0].timeline![0].text).toBe('执行命令（已完成）')
    expect(snapshots[0].timeline![0].tool).toMatchObject({ status: 'done', output: '完成' })
  })
})
