import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { AgentTurnError } from '../src/main/agent-errors'
import type { DialogueLine, ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.resolve(projectRoot, '.cache', 'tests', randomUUID())
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a test directory outside the project.')
  }
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('approved test-note capability', () => {
  it('does not write before approval, then creates and reads back one new file', async () => {
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined)
    await runtime.sendMessage('记录：今天验证桌面智能体的审批流程')
    const proposal = runtime.getSnapshot().proposal
    expect(proposal?.target).toContain(path.join('sandbox', 'notes'))
    await expect(fs.stat(proposal!.target)).rejects.toMatchObject({ code: 'ENOENT' })

    await runtime.approveAction(proposal!.id)
    const finalState = runtime.getSnapshot()
    expect(finalState.taskStatus).toBe('done')
    expect(finalState.proposal).toBeUndefined()
    expect(await fs.readFile(proposal!.target, 'utf8')).toBe(proposal!.content)
  })

  it('does not create a file after rejection or stop', async () => {
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined)
    await runtime.sendMessage('记录：这条应被拒绝')
    const rejected = runtime.getSnapshot().proposal!
    runtime.rejectAction(rejected.id)
    await runtime.approveAction(rejected.id)
    await expect(fs.stat(rejected.target)).rejects.toMatchObject({ code: 'ENOENT' })

    await runtime.sendMessage('记录：这条应被停止')
    const stopped = runtime.getSnapshot().proposal!
    runtime.stop()
    await runtime.approveAction(stopped.id)
    expect(runtime.getSnapshot().taskStatus).toBe('cancelled')
    await expect(fs.stat(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses overwrite and any caller-supplied path outside the sandbox', async () => {
    const store = new NoteStore(testRoot)
    const draft = store.makeDraft('标题', '内容')
    await store.createAndVerify(draft)
    await expect(store.createAndVerify(draft)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(draft.target, 'utf8')).toBe(draft.content)

    const outside = path.resolve(testRoot, path.basename(draft.target))
    await expect(store.createAndVerify({ ...draft, target: outside })).rejects.toThrow('写入路径不在测试目录内')
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a notes-directory link that redirects writes elsewhere', async () => {
    const store = new NoteStore(testRoot)
    const sandbox = path.join(testRoot, 'sandbox')
    const outside = path.join(testRoot, 'outside')
    await fs.mkdir(sandbox)
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(sandbox, 'notes'), 'junction')
    const draft = store.makeDraft('链接测试', '不能写出测试目录')
    await expect(store.createAndVerify(draft)).rejects.toThrow('符号链接')
    expect(await fs.readdir(outside)).toEqual([])
  })
})

describe('task cancellation', () => {
  it('tracks task elapsed time and only shows usage supplied by the model', async () => {
    let during: ReturnType<AgentRuntime['getSnapshot']>['taskMetrics']
    let runtime!: AgentRuntime
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, _tool, onTaskUsage) => {
        onTaskUsage?.({ total: 42, input: 30, output: 12 })
        during = runtime.getSnapshot().taskMetrics
        return { text: '完成' }
      }
    }
    runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('测试用量')
    const finished = runtime.getSnapshot().taskMetrics
    expect(during?.usedTokens).toBe(42)
    expect(during?.finishedAt).toBeUndefined()
    expect(finished?.usedTokens).toBe(42)
    expect(finished?.usage).toEqual({ total: 42, input: 30, output: 12 })
    expect(Date.parse(finished!.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(finished!.startedAt))
  })

  it('does not present context occupancy as the current task token cost', async () => {
    const model = {
      respond: async () => ({ text: '完成', sdkSessionId: 'session-1' }),
      getContextUsage: async () => ({ status: 'available' as const, usedTokens: 80_000, maxTokens: 128_000 })
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('测试区分')
    expect(runtime.getSnapshot().contextUsage?.usedTokens).toBe(80_000)
    expect(runtime.getSnapshot().taskMetrics?.usedTokens).toBeUndefined()
  })

  it('sends bounded @file content to the model without persisting it and rejects escaping paths before model dispatch', async () => {
    const workspace = path.join(testRoot, 'workspace')
    await fs.mkdir(path.join(workspace, 'docs'), { recursive: true })
    await fs.writeFile(path.join(workspace, 'docs', 'plan.md'), 'PRIVATE FILE CONTENT', 'utf8')
    await fs.writeFile(path.join(testRoot, 'outside.md'), 'OUTSIDE CONTENT', 'utf8')
    const calls: DialogueLine[][] = []
    const model: ModelClient = {
      respond: async (history) => {
        calls.push(structuredClone(history))
        return { text: '已读取' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model, workspace)
    const original = '总结 @{docs/plan.md}'
    await runtime.sendMessage(original)
    expect(calls).toHaveLength(1)
    expect(calls[0].at(-1)?.content).toContain('PRIVATE FILE CONTENT')
    expect(runtime.exportConversationState().history.at(-2)?.content).toBe(original)
    expect(JSON.stringify(runtime.exportConversationState().history)).not.toContain('PRIVATE FILE CONTENT')

    await runtime.sendMessage('读取 @{../outside.md}')
    expect(calls).toHaveLength(1)
    expect(runtime.getSnapshot().taskStatus).toBe('failed')
    expect(runtime.getSnapshot().timeline.at(-1)?.text).toContain('不能越过工作区')
  })

  it('passes a dropped Word document path to the Claude model without treating @ in its name as a workspace mention', async () => {
    const workspace = path.join(testRoot, 'workspace')
    await fs.mkdir(workspace, { recursive: true })
    const docxPath = path.join(testRoot, 'notes@draft.docx')
    await fs.writeFile(docxPath, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]))
    const calls: DialogueLine[][] = []
    const model: ModelClient = { respond: async (history) => { calls.push(structuredClone(history)); return { text: '收到文件路径' } } }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model, workspace)
    await runtime.sendMessage('请分析这个 Word 文件', [{ name: 'notes@draft.docx', content: '', path: docxPath }])
    expect(calls).toHaveLength(1)
    expect(calls[0].at(-1)?.content).toContain(JSON.stringify(docxPath))
    expect(calls[0].at(-1)?.content).not.toContain('以下内容是文件数据')
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('keeps one structured tool activity entry as the SDK tool completes', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'start', input: '{"file_path":"README.md"}' })
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'result', output: '文件已读取' })
        return { text: '完成' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('读取')
    const tools = runtime.getSnapshot().timeline.filter((entry) => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].tool).toMatchObject({ toolUseId: 'read-1', name: 'Read', status: 'done', output: '文件已读取' })
  })

  it('places the final streamed answer after tool calls and retains tool details', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, onProgress, _session, onToolEvent) => {
        onProgress?.('先检查文件。', 0)
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'start', input: '{"file_path":"README.md"}' })
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'result', output: '文件内容', isError: false })
        onProgress?.('已读取文件，以下是结论。', 1)
        return { text: '已读取文件，以下是结论。', timelineHandled: true }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('读文件并回答')
    const entries = runtime.getSnapshot().timeline
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(entries[1].text).toBe('先检查文件。')
    expect(entries[2].tool).toMatchObject({ input: '{"file_path":"README.md"}', output: '文件内容', status: 'done' })
    expect(entries[3].text).toBe('已读取文件，以下是结论。')
  })

  it('keeps concurrent tool results with their calls and marks an unfinished tool on failure', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, onProgress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'a', toolName: 'Read', phase: 'start', input: 'A' })
        onToolEvent?.({ toolUseId: 'b', toolName: 'Bash', phase: 'start', input: 'B' })
        onToolEvent?.({ toolUseId: 'b', toolName: 'Bash', phase: 'result', output: 'B failed', isError: true })
        onProgress?.('正在检查 A', 2)
        throw new Error('会话中断')
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('并发执行')
    const entries = runtime.getSnapshot().timeline
    const tools = entries.filter((entry) => entry.kind === 'tool')
    expect(tools.map((entry) => entry.tool?.toolUseId)).toEqual(['a', 'b'])
    expect(tools[0].tool).toMatchObject({ status: 'error', output: '未完成' })
    expect(tools[1].tool).toMatchObject({ status: 'error', output: 'B failed' })
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'tool', 'tool', 'assistant', 'system'])
    expect(runtime.getSnapshot().taskStatus).toBe('failed')
  })

  it('resumes the saved SDK session and drops it after another model handles a turn', async () => {
    const resumed: Array<string | null | undefined> = []
    const sdk: ModelClient = {
      respond: async (_history, _signal, _progress, sessionId) => {
        resumed.push(sessionId)
        return { text: 'SDK 回复', sdkSessionId: 'session-next' }
      }
    }
    const direct: ModelClient = { respond: async () => ({ text: '普通回复' }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), direct, undefined, sdk)
    const record = {
      id: 'saved', title: '旧会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [], pendingMessages: [], sdkSessionId: 'session-old'
    }
    runtime.restoreConversation(record)
    await runtime.sendMessage('续接')
    expect(resumed).toEqual(['session-old'])
    expect(runtime.exportConversationState().sdkSessionId).toBe('session-next')
    runtime.setModelMode('live')
    await runtime.sendMessage('另一模型的回合')
    runtime.setModelMode('claude_code')
    await runtime.sendMessage('重新开始 SDK 会话')
    expect(resumed).toEqual(['session-old', null])
  })

  it('restores the saved SDK session even when the last stored turn is an unanswered user message', async () => {
    const resumed: Array<string | null | undefined> = []
    const sdk: ModelClient = {
      respond: async (_history, _signal, _progress, sessionId) => {
        resumed.push(sessionId)
        return { text: '继续处理', sdkSessionId: sessionId }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, sdk)
    runtime.restoreConversation({
      id: 'interrupted', title: '被打断的会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'cancelled' as const,
      timeline: [], history: [{ role: 'user' as const, content: '还没回答的问题' }],
      pendingMessages: [], sdkSessionId: 'session-live'
    })
    await runtime.sendMessage('继续')
    expect(resumed).toEqual(['session-live'])
  })

  it('records the pictures of a user message on its timeline entry', async () => {
    const sdk: ModelClient = { respond: async () => ({ text: '看到了', sdkSessionId: 's1' }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, sdk)
    await runtime.sendMessage('看看这张图', [
      { name: 'shot.png', path: 'D:\\pics\\shot.png', content: '' },
      { name: 'notes.txt', path: 'D:\\pics\\notes.txt', content: '' }
    ])
    const entry = runtime.getSnapshot().timeline.find((item) => item.kind === 'user')
    expect(entry?.images).toEqual([{ name: 'shot.png', path: 'D:\\pics\\shot.png' }])
    expect(entry?.text).toContain('附件：shot.png、notes.txt')
  })

  it('forwards an interrupt only while the SDK client is the active model', async () => {
    const interrupted: number[] = []
    const sdk: ModelClient = {
      respond: async () => ({ text: '空闲' }),
      interrupt: async () => { interrupted.push(1) }
    }
    const direct: ModelClient = { respond: async () => ({ text: '普通' }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), direct, undefined, sdk)
    await runtime.interruptTurn()
    expect(interrupted).toHaveLength(1)
    runtime.setModelMode('live')
    await runtime.interruptTurn()
    expect(interrupted).toHaveLength(1)
  })

  it('drops a resume id the CLI no longer knows and explains why', async () => {
    const sdk: ModelClient = {
      respond: async () => {
        throw new AgentTurnError({
          kind: 'session-missing',
          message: '云端会话记录已失效；本地记录仍在，下一条消息会带着它重新开始。',
          missingSessionId: 'session-dead',
          invalidatesSession: true
        })
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, sdk)
    runtime.restoreConversation({
      id: 'dead', title: '失效会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [], pendingMessages: [], sdkSessionId: 'session-dead'
    })
    await runtime.sendMessage('继续')
    expect(runtime.getSnapshot().taskStatus).toBe('failed')
    expect(runtime.exportConversationState().sdkSessionId).toBeNull()
    expect(runtime.getSnapshot().timeline.some((item) => item.text.includes('云端会话记录已失效'))).toBe(true)
  })

  it('keeps the SDK session when a running turn is stopped', async () => {
    const resumed: Array<string | null | undefined> = []
    let releaseFirst!: (reply: ModelReply) => void
    const sdk: ModelClient = {
      respond: (_history, _signal, _progress, sessionId) => {
        resumed.push(sessionId)
        return resumed.length === 1
          ? new Promise<ModelReply>((resolve) => { releaseFirst = resolve })
          : Promise.resolve({ text: '第二条回复', sdkSessionId: 'session-next' })
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, sdk)
    runtime.restoreConversation({
      id: 'stopped', title: '被停止的会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [{ role: 'assistant' as const, content: '之前的回复' }],
      pendingMessages: [], sdkSessionId: 'session-old'
    })
    const firstRun = runtime.sendMessage('第一条')
    runtime.stop()
    releaseFirst({ text: '迟到的回复', sdkSessionId: 'session-late' })
    await firstRun
    await runtime.sendMessage('第二条')
    expect(resumed).toEqual(['session-old', 'session-old'])
    expect(runtime.exportConversationState().sdkSessionId).toBe('session-next')
  })

  it('updates one assistant entry as Claude Code streams text', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, onProgress) => {
        onProgress?.('你')
        onProgress?.('你好')
        return { text: '你好' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('打个招呼')
    const assistantEntries = runtime.getSnapshot().timeline.filter((entry) => entry.kind === 'assistant')
    expect(assistantEntries).toHaveLength(1)
    expect(assistantEntries[0].text).toBe('你好')
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('discards a model reply that arrives after stop', async () => {
    let complete!: (reply: ModelReply) => void
    const model: ModelClient = {
      respond: (_history: DialogueLine[], _signal: AbortSignal) =>
        new Promise<ModelReply>((resolve) => {
          complete = resolve
        })
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), model)
    const pending = runtime.sendMessage('请创建笔记')
    runtime.stop()
    complete({ text: '准备写入', note: { title: '迟到', content: '不应出现' } })
    await pending
    expect(runtime.getSnapshot().taskStatus).toBe('cancelled')
    expect(runtime.getSnapshot().proposal).toBeUndefined()
  })
})
