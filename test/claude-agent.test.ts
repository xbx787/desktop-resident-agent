import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

const queryMock = vi.hoisted(() => vi.fn())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }))

import { ClaudeAgentClient, boundedConversation } from '../src/main/claude-agent'
import { AgentTurnError } from '../src/main/agent-errors'
import type { DialogueLine, ModelToolEvent } from '../src/main/deepseek'
import type { PlanApprovalRequest, TaskUsage } from '../src/shared/contracts'

const executable = path.join(process.cwd(), 'package.json')
const sessionId = '11111111-1111-4111-8111-111111111111'
const configDir = path.join(process.cwd(), 'data', 'claude')

type Request = {
  prompt: AsyncIterable<SDKUserMessage>
  options: {
    resume?: string
    persistSession: boolean
    env: Record<string, string>
    mcpServers: Record<string, unknown>
    tools?: string[]
    hooks: { PostCompact: Array<{ hooks: Array<() => Promise<unknown>> }> }
    canUseTool: (toolName: string, input: Record<string, unknown>, options: { signal: AbortSignal }) =>
      Promise<{ behavior: string; message?: string; interrupt?: boolean; updatedInput?: unknown }>
  }
}

function fakeQuery(
  request: Request,
  respond: (message: SDKUserMessage) => AsyncIterable<Record<string, unknown>>,
  usage: () => Record<string, unknown> = () => ({ totalTokens: 120, maxTokens: 1_000_000, isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })
) {
  const generator = (async function* () {
    for await (const message of request.prompt) yield* respond(message)
  })()
  return Object.assign(generator, { getContextUsage: vi.fn(async () => usage()), close: vi.fn(), interrupt: vi.fn(async () => undefined),
    setPermissionMode: vi.fn(async () => undefined) })
}

beforeEach(() => queryMock.mockReset())

describe('Claude Agent SDK persistent streaming session', () => {
  it('redacts saved profile credentials from SDK text and streamed progress', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'saved-secret extra-secret-value' } } }
      yield { type: 'result', subtype: 'success', is_error: false,
        result: 'launch-secret saved-secret extra-secret-value', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'launch-secret', process.cwd())
    client.setProvider({ baseUrl: 'https://example.test', model: 'model-1', apiKey: 'saved-secret',
      extraEnv: 'CUSTOM_TOKEN=extra-secret-value' })
    try {
      const updates: string[] = []
      const reply = await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        (text) => updates.push(text))
      expect(reply.text).not.toMatch(/launch-secret|saved-secret|extra-secret-value/u)
      expect(updates.join(' ')).not.toMatch(/launch-secret|saved-secret|extra-secret-value/u)
    } finally { await client.dispose() }
  })

  it('reports real per-turn main-agent tokens while streaming and after the result', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { id: 'message-1', content: [], usage: { input_tokens: 10, output_tokens: 2,
          cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { id: 'message-1', content: [], usage: { input_tokens: 10, output_tokens: 3,
          cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } } }
      yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4, cache_creation_input_tokens: 1 } }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const updates: TaskUsage[] = []
      await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        undefined, undefined, undefined, (usage) => updates.push(usage))
      expect(updates.map((item) => item.total)).toEqual([17, 18, 20])
      // The split the endpoint billed is kept, not just the sum.
      expect(updates[2]).toEqual({ total: 20, input: 10, output: 5, cacheRead: 4, cacheCreate: 1 })
    } finally { await client.dispose() }
  })

  it('ignores subagent tool events — they carry a parent tool use id and belong to their Task card', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'assistant', parent_tool_use_id: 'agent-1',
        message: { id: 'message-sub', content: [{ type: 'tool_use', id: 'inner-1', name: 'Bash', input: { command: 'sleep 10' } }] } }
      yield { type: 'user', parent_tool_use_id: 'agent-1',
        message: { content: [{ type: 'tool_result', tool_use_id: 'inner-1', content: 'ok' }] } }
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { id: 'message-main', content: [{ type: 'tool_use', id: 'outer-1', name: 'Agent', input: { description: '睡 10 秒' } }] } }
      yield { type: 'user', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_result', tool_use_id: 'outer-1', content: 'done' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const events: ModelToolEvent[] = []
      await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        undefined, undefined, (event) => events.push(event))
      expect(events.map((event) => `${event.phase}:${event.toolUseId}`)).toEqual(['start:outer-1', 'result:outer-1'])
    } finally { await client.dispose() }
  })

  it('streams thinking deltas to the thinking callback without mixing them into the reply', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '先读文件' } } }
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '再改代码' } } }
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '改好了' } } }
      yield { type: 'result', subtype: 'success', is_error: false, result: '改好了', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const thinking: string[] = []
      const progress: string[] = []
      const reply = await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        (text) => { if (text) progress.push(text) }, undefined, undefined, undefined,
        (text) => thinking.push(text))
      expect(thinking).toEqual(['先读文件', '先读文件再改代码'])
      expect(progress).toContain('改好了')
      expect(reply.text).toBe('改好了')
    } finally { await client.dispose() }
  })

  it('opens a saved SDK session on demand before reading its context usage', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* () {}))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      expect(await client.getContextUsage(sessionId)).toMatchObject({ status: 'available', usedTokens: 120 })
      expect((queryMock.mock.calls[0][0] as Request).options.resume).toBe(sessionId)
    } finally { await client.dispose() }
  })

  it('does not display synthetic zero usage from a failed startup result', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId,
        user_message_uuids: [message.uuid], usage: { input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const updates: TaskUsage[] = []
      await expect(client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        undefined, undefined, undefined, (usage) => updates.push(usage))).rejects.toThrow('运行失败')
      expect(updates).toEqual([])
    } finally { await client.dispose() }
  })

  it('starts with a streaming input and resumes without replaying old messages', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      sent.push(String(message.message.content))
      if (sent.length === 1) yield { type: 'system', subtype: 'init',
        slash_commands: ['/compact', '/review', '/status'], terminal_slash_commands: ['/status'], skills: ['review'] }
      yield { type: 'result', subtype: 'success', is_error: false, result: '已处理', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))

    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd(), configDir)
    try {
      const first = await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
      const second = await client.respond([
        { role: 'user', content: '你好' }, { role: 'assistant', content: '已处理' }, { role: 'user', content: '继续' }
      ], new AbortController().signal, undefined, sessionId)
      expect(queryMock).toHaveBeenCalledTimes(1)
      expect(sent).toEqual(['你好', '继续'])
      expect(first).toEqual({ text: '已处理', sdkSessionId: sessionId, compacted: false })
      expect(second.sdkSessionId).toBe(sessionId)
      const request = queryMock.mock.calls[0][0] as Request
      expect(request.options.persistSession).toBe(true)
      expect(request.options.env.CLAUDE_CONFIG_DIR).toBe(configDir)
      expect(request.options.tools).toBeUndefined()
      expect(client.getCommandCatalog()).toEqual({ commands: ['/compact', '/review'], skills: ['review'] })
    } finally { await client.dispose() }
  })

  it('does not persist or resume an ephemeral side session after its query is released', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      sent.push(String(message.message.content))
      yield { type: 'result', subtype: 'success', is_error: false, result: '已处理', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd(), undefined, {}, false)
    try {
      await client.respond([{ role: 'user', content: '第一次' }], new AbortController().signal)
      expect((queryMock.mock.calls[0][0] as Request).options.persistSession).toBe(false)
      await client.dispose()
      expect((await client.getContextUsage(sessionId)).status).toBe('unavailable')
      await expect(client.compact(sessionId)).rejects.toThrow('不能恢复后压缩')
      await client.respond([
        { role: 'user', content: '第一次' }, { role: 'assistant', content: '已处理' },
        { role: 'user', content: '第二次' }
      ], new AbortController().signal, undefined, sessionId)
      expect(queryMock).toHaveBeenCalledTimes(2)
      expect((queryMock.mock.calls[1][0] as Request).options.resume).toBeUndefined()
      expect((queryMock.mock.calls[1][0] as Request).options.persistSession).toBe(false)
      expect(sent[1]).toContain('第一次')
      expect(sent[1]).toContain('第二次')
    } finally { await client.dispose() }
  })

  it('keeps more than the last twelve turns in a session-less transcript prompt', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      sent.push(String(message.message.content))
      yield { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const history: DialogueLine[] = []
      for (let index = 0; index < 20; index += 1) {
        history.push({ role: 'user', content: `问题 ${index}` })
        history.push({ role: 'assistant', content: `回答 ${index}` })
      }
      history.push({ role: 'user', content: '继续' })
      await client.respond(history, new AbortController().signal)
      expect(sent[0]).toContain('问题 0')
      expect(sent[0]).toContain('继续')
    } finally { await client.dispose() }
  })

  it('drops the oldest turns first when a session-less transcript exceeds its budget', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      sent.push(String(message.message.content))
      yield { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const history: DialogueLine[] = []
      for (let index = 0; index < 8; index += 1) {
        history.push({ role: 'user', content: `第${index}轮` + '长'.repeat(7_900) })
        history.push({ role: 'assistant', content: '答'.repeat(7_990) })
      }
      history.push({ role: 'user', content: '最新问题' })
      await client.respond(history, new AbortController().signal)
      expect(sent[0]).toContain('最新问题')
      expect(sent[0]).toContain('第7轮')
      expect(sent[0]).not.toContain('第0轮')
    } finally { await client.dispose() }
  })

  it('folds native steer into the running turn rather than interrupting it', async () => {
    const sent: SDKUserMessage[] = []
    queryMock.mockImplementation((request: Request) => {
      const generator = (async function* () {
        const input = request.prompt[Symbol.asyncIterator]()
        const first = (await input.next()).value
        sent.push(first)
        yield { type: 'stream_event', parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '执行第一阶段' } } }
        const steer = (await input.next()).value
        sent.push(steer)
        yield { type: 'result', subtype: 'success', is_error: false, result: '已按引导继续', session_id: sessionId,
          user_message_uuids: [first.uuid, steer.uuid], queued_turn_count: 0 }
      })()
      return Object.assign(generator, { getContextUsage: vi.fn(async () => ({ totalTokens: 100, maxTokens: 1_000_000,
        isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })), close: vi.fn() })
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      let steerPromise: Promise<boolean> | undefined
      const reply = await client.respond([{ role: 'user', content: '完成任务' }], new AbortController().signal, () => {
        steerPromise ??= client.steer('x'.repeat(55_000))
      })
      expect(await steerPromise).toBe(true)
      expect(sent[1].priority).toBe('next')
      expect(String(sent[1].message.content)).toHaveLength(55_000)
      expect(reply.text).toBe('已按引导继续')
    } finally { await client.dispose() }
  })

  it('waits for a late steer that becomes a second native turn', async () => {
    queryMock.mockImplementation((request: Request) => {
      const generator = (async function* () {
        const input = request.prompt[Symbol.asyncIterator]()
        const first = (await input.next()).value
        yield { type: 'stream_event', parent_tool_use_id: null,
          event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '第一阶段' } } }
        const steer = (await input.next()).value
        yield { type: 'result', subtype: 'success', is_error: false, result: '第一阶段完成', session_id: sessionId,
          user_message_uuids: [first.uuid], queued_turn_count: 1 }
        yield { type: 'result', subtype: 'success', is_error: false, result: '第二阶段完成', session_id: sessionId,
          user_message_uuids: [steer.uuid], queued_turn_count: 0 }
      })()
      return Object.assign(generator, { getContextUsage: vi.fn(async () => ({ totalTokens: 100, maxTokens: 1_000_000,
        isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })), close: vi.fn() })
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      let steerPromise: Promise<boolean> | undefined
      const reply = await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal,
        () => { steerPromise ??= client.steer('补充') })
      expect(await steerPromise).toBe(true)
      expect(reply.text).toBe('第一阶段完成\n\n第二阶段完成')
    } finally { await client.dispose() }
  })

  it('reports exact SDK context usage and sends the native compact command', async () => {
    const sent: string[] = []
    let used = 700_000
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      const prompt = String(message.message.content)
      sent.push(prompt)
      if (prompt === '/compact') {
        await request.options.hooks.PostCompact[0].hooks[0]()
        used = 90_000
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }, () => ({ totalTokens: used, maxTokens: 1_000_000, autoCompactThreshold: 700_000,
      isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
      expect((await client.getContextUsage(sessionId)).usedPercent).toBe(70)
      const after = await client.compact(sessionId)
      expect(sent).toEqual(['你好', '/compact'])
      expect(after).toMatchObject({ status: 'available', usedTokens: 90_000, remainingPercent: 91,
        compactionOutcome: 'compacted' })
    } finally { await client.dispose() }
  })

  it('emits structured tool activity with the configured MCP server available', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'mcp__windows-mcp__click', input: { target: 'safe' } }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' }] } }
      yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd(), configDir, {
      'windows-mcp': { command: 'node', args: ['dummy.js'] }
    })
    try {
      const events: unknown[] = []
      await client.respond([{ role: 'user', content: '测试' }], new AbortController().signal,
        undefined, undefined, (event) => events.push(event))
      expect(events).toEqual([
        { toolUseId: 'tool-1', toolName: 'mcp__windows-mcp__click', phase: 'start', input: '{\n  "target": "safe"\n}' },
        { toolUseId: 'tool-1', toolName: 'mcp__windows-mcp__click', phase: 'result', output: 'ok', isError: false }
      ])
      expect((queryMock.mock.calls[0][0] as Request).options.mcpServers).toHaveProperty('windows-mcp')
    } finally { await client.dispose() }
  })

  it('streams separate text segments around tool use and exposes the actual tool result', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '先检查文件。' } } }
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'text', text: '先检查文件。' }] } }
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'README.md' } }] } }
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-1',
        content: [{ type: 'text', text: '第一行\n第二行' }] }] } }
      yield { type: 'stream_event', parent_tool_use_id: null,
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '文件已读取。' } } }
      yield { type: 'result', subtype: 'success', is_error: false, result: '文件已读取。', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const progress: Array<[string, number | undefined]> = []
      const events: Array<{ phase: string; input?: string; output?: string }> = []
      const reply = await client.respond([{ role: 'user', content: '检查文件' }], new AbortController().signal,
        (text, segment) => progress.push([text, segment]), undefined, (event) => events.push(event))
      expect(progress).toEqual([
        ['先检查文件。', 0], ['', 1], ['文件已读取。', 1], ['文件已读取。', 1]
      ])
      expect(events[0].input).toBe('{\n  "file_path": "README.md"\n}')
      expect(events[1].output).toBe('第一行\n第二行')
      expect(reply).toMatchObject({ text: '文件已读取。', timelineHandled: true })
    } finally { await client.dispose() }
  })

  it('closes an unfinished tool as failed when the SDK turn fails', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { content: [{ type: 'tool_use', id: 'bash-1', name: 'Bash', input: { command: 'echo test' } }] } }
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const events: Array<{ phase: string; isError?: boolean; output?: string }> = []
      await expect(client.respond([{ role: 'user', content: '测试命令' }], new AbortController().signal,
        undefined, undefined, (event) => events.push(event))).rejects.toThrow('Claude Agent 运行失败')
      expect(events).toHaveLength(2)
      expect(events[1]).toMatchObject({ phase: 'result', isError: true, output: 'Claude Agent 运行失败（error_during_execution）。' })
    } finally { await client.dispose() }
  })

  it('reports the CLI’s own explanation when a success-subtype result carries an error', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'result', subtype: 'success', is_error: true, session_id: sessionId,
        result: 'There is an issue with the selected model (deepseek-flash).',
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await expect(client.respond([{ role: 'user', content: '你好' }], new AbortController().signal,
        undefined, undefined, () => {})).rejects.toThrow('There is an issue with the selected model')
    } finally { await client.dispose() }
  })

  it('precompacts before the next message when its conservative budget crosses 70%', async () => {
    const sent: string[] = []
    let used = 690_000
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      const prompt = String(message.message.content)
      sent.push(prompt)
      if (prompt === '/compact') {
        await request.options.hooks.PostCompact[0].hooks[0]()
        used = 80_000
      }
      yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }, () => ({ totalTokens: used, maxTokens: 1_000_000, autoCompactThreshold: 700_000,
      isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '第一次' }], new AbortController().signal)
      await client.respond([{ role: 'user', content: '第二次' }], new AbortController().signal,
        undefined, sessionId)
      expect(sent).toEqual(['第一次', '/compact', '第二次'])
      expect((queryMock.mock.calls[0][0] as Request).options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe('70')
    } finally { await client.dispose() }
  })

  it('compacts an unknown resumed context before the first user prompt', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => {
      const generator = fakeQuery(request, async function* (message) {
        const prompt = String(message.message.content)
        sent.push(prompt)
        if (prompt === '/compact') await request.options.hooks.PostCompact[0].hooks[0]()
        yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
          user_message_uuids: [message.uuid], queued_turn_count: 0 }
      })
      generator.getContextUsage.mockImplementation(async () => {
        if (!sent.includes('/compact')) throw new Error('unavailable')
        return { totalTokens: 100, maxTokens: 1_000_000, isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' }
      })
      return generator
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '恢复后继续' }], new AbortController().signal,
        undefined, sessionId)
      expect(sent).toEqual(['/compact', '恢复后继续'])
      expect((queryMock.mock.calls[0][0] as Request).options.resume).toBe(sessionId)
    } finally { await client.dispose() }
  })

  it('does not let a prefetched usage check make the next message look live', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => {
      const generator = fakeQuery(request, async function* (message) {
        const prompt = String(message.message.content)
        sent.push(prompt)
        if (prompt === '/compact') await request.options.hooks.PostCompact[0].hooks[0]()
        yield { type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: sessionId,
          user_message_uuids: [message.uuid], queued_turn_count: 0 }
      })
      generator.getContextUsage.mockImplementation(async () => {
        if (!sent.includes('/compact')) throw new Error('context control unavailable')
        return { totalTokens: 100, maxTokens: 1_000_000, isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' }
      })
      return generator
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      // Opening a conversation asks for the count straight away. That spawns the
      // resumed query, and the query must not count as streamed: otherwise the
      // next message would be refused instead of probing and compacting.
      await expect(client.getContextUsage(sessionId)).resolves.toMatchObject({ status: 'unavailable' })
      await client.respond([{ role: 'user', content: '恢复后继续' }], new AbortController().signal, undefined, sessionId)
      expect(sent).toEqual(['/compact', '恢复后继续'])
    } finally { await client.dispose() }
  })

  it('treats a short manual compact as a no-op and still refreshes usage', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      const prompt = String(message.message.content)
      yield { type: 'result', subtype: 'success', is_error: false,
        result: prompt === '/compact' ? 'Not enough messages to compact.' : '好的', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '你好' }], new AbortController().signal)
      expect(await client.compact(sessionId)).toMatchObject({ status: 'available', compactionOutcome: 'not_needed' })
    } finally { await client.dispose() }
  })

  it('refuses a live-session message when exact context usage cannot be read', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => {
      const generator = fakeQuery(request, async function* (message) {
        sent.push(String(message.message.content))
        yield { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: sessionId,
          user_message_uuids: [message.uuid], queued_turn_count: 0 }
      })
      generator.getContextUsage.mockRejectedValue(new Error('context control unavailable'))
      return generator
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '第一条' }], new AbortController().signal)
      await expect(client.respond([{ role: 'user', content: '第二条' }], new AbortController().signal,
        undefined, sessionId)).rejects.toThrow('消息未发送')
      expect(sent).toEqual(['第一条'])
    } finally { await client.dispose() }
  })

  it('refuses to send after compaction if the refreshed context count fails', async () => {
    const sent: string[] = []
    queryMock.mockImplementation((request: Request) => {
      const generator = fakeQuery(request, async function* (message) {
        const prompt = String(message.message.content)
        sent.push(prompt)
        if (prompt === '/compact') await request.options.hooks.PostCompact[0].hooks[0]()
        yield { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: sessionId,
          user_message_uuids: [message.uuid], queued_turn_count: 0 }
      })
      generator.getContextUsage.mockImplementation(async () => {
        if (sent.includes('/compact')) throw new Error('context control unavailable')
        return { totalTokens: 690_000, maxTokens: 1_000_000, autoCompactThreshold: 700_000,
          isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' }
      })
      return generator
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '第一条' }], new AbortController().signal)
      await expect(client.respond([{ role: 'user', content: '第二条' }], new AbortController().signal,
        undefined, sessionId)).rejects.toThrow('压缩后无法核验')
      expect(sent).toEqual(['第一条', '/compact'])
    } finally { await client.dispose() }
  })
})

describe('ExitPlanMode plan approval parking', () => {
  /** Opens a client whose query has started (so canUseTool exists) without
   *  running a turn — the plan approval path is exercised directly. */
  async function openClient() {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* () {}))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    await client.getContextUsage(sessionId)
    const request = queryMock.mock.calls[0][0] as Request
    return { client, canUseTool: request.options.canUseTool }
  }

  it('parks an ExitPlanMode until the host approves the plan', async () => {
    const { client, canUseTool } = await openClient()
    try {
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      const verdict = canUseTool('ExitPlanMode', { plan: '先读日志，再改配置' }, { signal: new AbortController().signal })
      await vi.waitFor(() => expect(parked).toHaveLength(1))
      expect(parked[0]).toMatchObject({ plan: '先读日志，再改配置' })
      expect(client.answerPlan(parked[0]!.id, true)).toBe(true)
      await expect(verdict).resolves.toEqual({ behavior: 'allow' })
      expect(parked[1]).toBeNull()
    } finally { await client.dispose() }
  })

  it('sends a rejected plan back to the model without interrupting the turn', async () => {
    const { client, canUseTool } = await openClient()
    try {
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      const verdict = canUseTool('ExitPlanMode', { plan: '一个计划' }, { signal: new AbortController().signal })
      await vi.waitFor(() => expect(parked).toHaveLength(1))
      expect(client.answerPlan(parked[0]!.id, false)).toBe(true)
      await expect(verdict).resolves.toEqual({
        behavior: 'deny',
        message: 'The user rejected this plan. Stay in plan mode and revise it before proposing again.'
      })
    } finally { await client.dispose() }
  })

  it('denies with interrupt when the parked plan is cancelled mid-review', async () => {
    const { client, canUseTool } = await openClient()
    try {
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      const controller = new AbortController()
      const verdict = canUseTool('ExitPlanMode', { plan: '一个计划' }, { signal: controller.signal })
      await vi.waitFor(() => expect(parked).toHaveLength(1))
      controller.abort()
      await expect(verdict).resolves.toEqual({ behavior: 'deny', message: 'User cancelled the plan review.', interrupt: true })
      expect(parked[1]).toBeNull()
    } finally { await client.dispose() }
  })

  it('rejects blank plans and refuses stale verdicts', async () => {
    const { client, canUseTool } = await openClient()
    try {
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      await expect(canUseTool('ExitPlanMode', { plan: '  ' }, { signal: new AbortController().signal }))
        .resolves.toEqual({ behavior: 'deny', message: 'A plan must contain text before it can be approved. Stay in plan mode and write a plan.' })
      await expect(canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal }))
        .resolves.toEqual({ behavior: 'allow' })
      expect(client.answerPlan('missing', true)).toBe(false)
      expect(parked).toEqual([])
    } finally { await client.dispose() }
  })

  it('settles a parked plan when the query closes mid-review', async () => {
    const { client, canUseTool } = await openClient()
    try {
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      const verdict = canUseTool('ExitPlanMode', { plan: '一个计划' }, { signal: new AbortController().signal })
      await vi.waitFor(() => expect(parked).toHaveLength(1))
      await client.dispose()
      await expect(verdict).resolves.toEqual({ behavior: 'deny', message: 'User cancelled the plan review.', interrupt: true })
    } finally { await client.dispose() }
  })
})

describe('plan and goal confirmation', () => {
  it('waits for SDK init to confirm a cold plan-mode request', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'system', subtype: 'init', permissionMode: 'plan', slash_commands: [], skills: [] }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const confirmed: boolean[] = []
      client.setPlanModeListener((on) => confirmed.push(on))
      expect(await client.setPlanMode(true)).toBe(false)
      expect(confirmed).toEqual([])
      await client.respond([{ role: 'user', content: '请先计划' }], new AbortController().signal)
      expect(confirmed).toEqual([true])
    } finally { await client.dispose() }
  })
  it('waits for the SDK permission-mode acknowledgment and keeps the old mode after rejection', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      await client.respond([{ role: 'user', content: '先运行一次' }], new AbortController().signal)
      const active = queryMock.mock.results[0].value as { setPermissionMode: ReturnType<typeof vi.fn> }
      let confirm!: () => void
      active.setPermissionMode.mockImplementationOnce(() => new Promise<void>((resolve) => { confirm = resolve }))
      const switching = client.setPlanMode(true)
      expect((client as unknown as { planMode: boolean }).planMode).toBe(false)
      confirm()
      await switching
      expect(active.setPermissionMode).toHaveBeenCalledWith('plan')
      expect((client as unknown as { planMode: boolean }).planMode).toBe(true)
      active.setPermissionMode.mockRejectedValueOnce(new Error('control channel failed'))
      await expect(client.setPlanMode(false)).rejects.toThrow('control channel failed')
      expect((client as unknown as { planMode: boolean }).planMode).toBe(true)
    } finally { await client.dispose() }
  })

  it('uses active_goal events for counted rounds and clears on an SDK null event', async () => {
    let turn = 0
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      turn += 1
      yield { type: 'active_goal', value: turn === 1
        ? { condition: '写完测试', iterations: 2, set_at: Date.now() } : null,
      uuid: randomUUID(), session_id: sessionId }
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const goals: Array<unknown> = []
      client.setGoalListener((goal) => goals.push(goal))
      await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal)
      await client.respond([{ role: 'user', content: '继续' }], new AbortController().signal, undefined, sessionId)
      expect(goals[0]).toMatchObject({ condition: '写完测试', phase: 'confirmed', iterations: 2 })
      expect(goals[1]).toBeNull()
    } finally { await client.dispose() }
  })
})

describe('bounded conversation packing', () => {
  const line = (role: 'user' | 'assistant', content: string): DialogueLine => ({ role, content })

  it('keeps the whole transcript when it fits', () => {
    const history = [line('user', '第一问'), line('assistant', '第一答'), line('user', '第二问')]
    expect(boundedConversation(history, 10_000)).toEqual(history)
  })

  it('keeps a recent frozen reference intact when a cold SDK session replays history', () => {
    const context = '引'.repeat(4_000)
    const content = `引用问题\n\n${'文件内容'.repeat(8_000)}\n\n${context}`
    const packed = boundedConversation([
      { role: 'user', content, sessionContext: context },
      line('assistant', '先前答复'),
      line('user', '继续追问')
    ])
    expect(packed[0].content).toContain('引用问题')
    expect(packed[0].content).toContain(context)
    expect(packed[0].content.length).toBeLessThan(content.length)
    expect(packed.at(-1)?.content).toBe('继续追问')
  })

  it('compresses older lines to their opening before any of them is dropped', () => {
    const history = [
      line('user', '甲'.repeat(2_000)),
      line('assistant', '第一答'),
      line('user', '第二问')
    ]
    // Byte math: the two newest lines cost 57 each; 600 bytes of the oldest
    // (200 甲) cost 648 — exactly the leftover budget.
    const packed = boundedConversation(history, 114 + 648)
    expect(packed).toHaveLength(3)
    expect(packed[0]).toEqual(line('user', '甲'.repeat(200)))
    expect(packed[2]).toEqual(line('user', '第二问'))
  })

  it('marks what was dropped so the model knows the transcript was clipped', () => {
    const history = [
      line('user', '很旧的一问'), line('assistant', '很旧的一答'),
      line('user', '较新的一问'), line('assistant', '较新的一答'),
      line('user', '最新一问')
    ]
    const packed = boundedConversation(history, 150)
    expect(packed[0]).toEqual(line('user', '（更早的 3 条消息因篇幅省略）'))
    expect(packed).toHaveLength(3)
    expect(packed[2]).toEqual(line('user', '最新一问'))
  })

  it('squeezes a single message that overflows the whole budget, on a clean character boundary', () => {
    const packed = boundedConversation([line('user', '好'.repeat(400))], 300)
    expect(packed).toHaveLength(1)
    expect(packed[0].content.length).toBeLessThan(400)
    expect(packed[0].content).not.toContain('�')
  })
})

describe('turn cancellation fencing', () => {
  it('ignores late events from a turn that was stopped', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* (message) {
      yield { type: 'assistant', parent_tool_use_id: null,
        message: { id: 'm1', content: [{ type: 'text', text: '进行中' }], usage: { input_tokens: 1, output_tokens: 1 } } }
      // The CLI keeps pouring events after the abort; none of them may land.
      await new Promise((resolve) => setTimeout(resolve, 60))
      yield { type: 'result', subtype: 'success', is_error: false, result: '迟到的结果', session_id: sessionId,
        user_message_uuids: [message.uuid], queued_turn_count: 0 }
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const controller = new AbortController()
      const progress: string[] = []
      const run = client.respond([{ role: 'user', content: '开始' }], controller.signal,
        (text) => { if (text) progress.push(text) })
      // Wait for the first chunk to land instead of racing a fixed sleep.
      const deadline = Date.now() + 2_000
      while (!progress.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
      expect(progress).toEqual(['进行中'])
      controller.abort()
      await expect(run).rejects.toThrow('任务已停止')
      await new Promise((resolve) => setTimeout(resolve, 90))
      expect(progress).toEqual(['进行中'])
    } finally { await client.dispose() }
  })
})

describe('idle query release', () => {
  it('closes a query idle for half an hour and resumes the same session on the next turn', async () => {
    let closes = 0
    queryMock.mockImplementation((request: Request) => {
      const generator = fakeQuery(request, async function* (message) {
        yield { type: 'result', subtype: 'success', is_error: false, result: '好', session_id: sessionId,
          user_message_uuids: [message.uuid], queued_turn_count: 0 }
      })
      generator.close = vi.fn(() => { closes += 1 })
      return generator
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      vi.useFakeTimers()
      const reply = await client.respond([{ role: 'user', content: '开始' }], new AbortController().signal)
      expect(reply.sdkSessionId).toBe(sessionId)
      expect(closes).toBe(0)
      await vi.advanceTimersByTimeAsync(30 * 60_000)
      expect(closes).toBe(1)
      vi.useRealTimers()
      await client.respond([
        { role: 'user', content: '开始' },
        { role: 'assistant', content: '好' },
        { role: 'user', content: '继续' }
      ], new AbortController().signal, undefined, sessionId)
      expect((queryMock.mock.calls[1][0] as Request).options.resume).toBe(sessionId)
    } finally {
      vi.useRealTimers()
      await client.dispose()
    }
  })
})

describe('Agent failure classification', () => {
  it('classifies a resume the CLI no longer knows and reports it as a typed failure', async () => {
    queryMock.mockImplementation((request: Request) => fakeQuery(request, async function* () {
      throw new Error(`No conversation found with session ID: ${sessionId}`)
    }))
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    try {
      const thrown = await client.respond([{ role: 'user', content: '继续' }], new AbortController().signal)
        .catch((error: unknown) => error)
      expect(thrown).toBeInstanceOf(AgentTurnError)
      expect((thrown as AgentTurnError).failure).toMatchObject({
        kind: 'session-missing',
        missingSessionId: sessionId,
        invalidatesSession: true
      })
    } finally { await client.dispose() }
  })

  it('routes interrupt() to the SDK query that owns the running turn', async () => {
    queryMock.mockImplementation((request: Request) => {
      // Take the send, then hang the stream without ever producing a result —
      // the turn stays running until interrupt() releases the gate.
      let release: () => void = () => {}
      const gate = new Promise<void>((resolve) => { release = resolve })
      const generator = (async function* () {
        for await (const message of request.prompt) {
          void message
          await gate
          return
        }
      })()
      return Object.assign(generator, {
        getContextUsage: vi.fn(async () => ({ totalTokens: 100, maxTokens: 1_000_000,
          isAutoCompactEnabled: true, model: 'deepseek-flash[1m]' })),
        close: vi.fn(),
        interrupt: vi.fn(async () => { release() })
      })
    })
    const client = new ClaudeAgentClient(executable, 'test-key', process.cwd())
    const run = client.respond([{ role: 'user', content: '跑一个很长的命令' }], new AbortController().signal)
      .catch(() => undefined)
    try {
      while (queryMock.mock.results.length === 0) await new Promise((resolve) => setTimeout(resolve, 5))
      await client.interrupt()
      const fake = queryMock.mock.results[0].value as { interrupt: ReturnType<typeof vi.fn> }
      expect(fake.interrupt).toHaveBeenCalledTimes(1)
    } finally {
      await client.dispose()
      await run
    }
  })
})
