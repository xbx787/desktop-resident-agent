import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationStore } from '../src/main/conversation-store'
import { AgentTurnError } from '../src/main/agent-errors'
import type { DialogueLine, ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'
import { usageSpendYuan } from '../src/shared/deepseek-pricing'
import type { AgentGoal, ApprovalMode, AskQuestionRequest, PlanApprovalRequest, SubagentTask } from '../src/shared/contracts'

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

describe('persona switching', () => {
  it('forwards a new preset to both model paths and opens a fresh SDK session', async () => {
    const sessions: Array<string | null | undefined> = []
    const claude: ModelClient = {
      setPersonaId: vi.fn(),
      respond: async (_history, _signal, _progress, sessionId) => {
        sessions.push(sessionId)
        return { text: '完成', sdkSessionId: 'old-sdk-session' }
      }
    }
    const direct: ModelClient = { setPersonaId: vi.fn(), respond: async () => ({ text: '收到' }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), direct, undefined, claude)
    await runtime.sendMessage('第一轮')
    expect(runtime.exportConversationState().sdkSessionId).toBe('old-sdk-session')
    runtime.setPersona('rin')
    expect(claude.setPersonaId).toHaveBeenCalledWith('rin')
    expect(direct.setPersonaId).toHaveBeenCalledWith('rin')
    expect(runtime.exportConversationState().sdkSessionId).toBeNull()
    await runtime.sendMessage('第二轮')
    expect(sessions).toEqual([null, null])
    runtime.setModelMode('live')
    runtime.setPersona('rem')
    expect(claude.setPersonaId).toHaveBeenCalledWith('rem')
    expect(direct.setPersonaId).toHaveBeenCalledWith('rem')
    await runtime.sendMessage('直连')
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('does not retain an old SDK resume id when the preset changes during a turn', async () => {
    let finish!: (reply: ModelReply) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => { entered = resolve })
    const model: ModelClient = {
      setPersonaId: vi.fn(),
      respond: () => { entered(); return new Promise<ModelReply>((resolve) => { finish = resolve }) }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const first = runtime.sendMessage('运行中')
    await started
    runtime.setPersona('yui')
    finish({ text: '旧人设这轮结束', sdkSessionId: 'stale-sdk' })
    await first
    expect(runtime.exportConversationState().sdkSessionId).toBeNull()
  })

  it('marks a live goal unverified and pauses its queue when the old session is replaced', () => {
    let onGoal: ((goal: { condition: string; phase: 'confirmed'; startedAt: string }) => void) | undefined
    const model: ModelClient = {
      respond: async () => ({ text: '完成' }),
      setGoalListener: (listener) => { onGoal = listener as typeof onGoal }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    onGoal?.({ condition: '完成任务', phase: 'confirmed', startedAt: new Date().toISOString() })
    runtime.setPersona('rin')
    expect(runtime.getSnapshot().goal).toMatchObject({ phase: 'unverified' })
    expect(runtime.getQueuePauseReason()).toContain('重新设定目标')
    onGoal?.({ condition: '完成任务', phase: 'confirmed', startedAt: new Date().toISOString() })
    expect(runtime.getSnapshot().goal).toMatchObject({ phase: 'unverified' })
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
    expect(runtime.exportConversationState().timeline.find((entry) => entry.kind === 'user')?.metrics).toEqual(finished)
  })

  it('retains each settled turn’s usage and its settlement-time price across a restore', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const firstUsage = { total: 200_000, input: 100_000, output: 100_000 }
      const secondUsage = { total: 300_000, input: 200_000, output: 100_000 }
      const usages = [firstUsage, secondUsage]
      const model: ModelClient = {
        respond: async (_history, _signal, _progress, _session, _tool, onTaskUsage) => {
          onTaskUsage?.(usages.shift()!)
          return { text: '完成' }
        }
      }
      const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
      vi.setSystemTime(new Date('2026-10-13T02:00:00.000Z')) // Beijing 10:00, peak
      await runtime.sendMessage('第一轮')
      const firstCharge = runtime.exportConversationState().spentYuan
      runtime.setModelMode('demo') // Emits again after completion; must not bill twice.
      expect(runtime.exportConversationState().spentYuan).toBe(firstCharge)
      runtime.setModelMode('claude_code')
      vi.setSystemTime(new Date('2026-10-13T12:00:00.000Z')) // Beijing 20:00, off peak
      await runtime.sendMessage('第二轮')
      const saved = runtime.exportConversationState()
      const turns = saved.timeline.filter((entry) => entry.kind === 'user')
      expect(turns.map((entry) => entry.metrics?.usage)).toEqual([firstUsage, secondUsage])
      expect(turns.map((entry) => entry.metrics?.spentYuan)).toEqual([
        usageSpendYuan(firstUsage, Date.parse(turns[0].metrics!.finishedAt!)),
        usageSpendYuan(secondUsage, Date.parse(turns[1].metrics!.finishedAt!))
      ])
      expect(turns.map((entry) => entry.metrics?.spentYuan)).toEqual([1, 0.6])
      const total = turns.reduce((sum, entry) => sum + (entry.metrics?.spentYuan ?? 0), 0)
      expect(saved.spentYuan).toBeCloseTo(total, 6)
      const restored = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
      restored.restoreConversation({
        id: 'saved', title: '已保存', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
        taskStatus: 'done', pendingMessages: [], ...saved
      })
      expect(restored.getSnapshot().timeline.filter((entry) => entry.kind === 'user').map((entry) => entry.metrics)).toEqual(turns.map((entry) => entry.metrics))
      expect(restored.getSnapshot().conversationSpentYuan).toBeCloseTo(total, 6)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the price unknown when only a total token count is reported', async () => {
    const model: ModelClient = { respond: async (_history, _signal, _progress, _session, _tool, onTaskUsage) => {
      onTaskUsage?.({ total: 42 })
      return { text: '完成' }
    } }
    const runtime = new AgentRuntime(new NoteStore(testRoot), model)
    await runtime.sendMessage('总量')
    const user = runtime.exportConversationState().timeline.find((entry) => entry.kind === 'user')
    expect(user?.metrics?.usedTokens).toBe(42)
    expect(user?.metrics?.spentYuan).toBeUndefined()
    expect(runtime.exportConversationState().spentYuan).toBeUndefined()
  })

  it('marks a user-interrupted reply as cancelled instead of failed', async () => {
    const model: ModelClient = { respond: async () => ({ text: '', interrupted: true }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('跑个长命令')
    const snapshot = runtime.getSnapshot()
    expect(snapshot.taskStatus).toBe('cancelled')
    expect(snapshot.avatarState).toBe('idle')
    expect(snapshot.timeline.some((entry) => entry.kind === 'system' && entry.text.includes('人工中止'))).toBe(true)
  })

  it('settles failed and stopped turns once even when later events arrive', async () => {
    const usage = { total: 100_000, input: 50_000, output: 50_000 }
    const failing: ModelClient = { respond: async (_history, _signal, _progress, _session, _tool, onTaskUsage) => {
      onTaskUsage?.(usage)
      throw new Error('请求失败')
    } }
    const failed = new AgentRuntime(new NoteStore(testRoot), failing)
    await failed.sendMessage('失败轮')
    const failure = failed.exportConversationState()
    expect(failed.getSnapshot().taskStatus).toBe('failed')
    expect(failure.timeline.find((entry) => entry.kind === 'user')?.metrics?.finishedAt).toBeTruthy()
    expect(failure.timeline.find((entry) => entry.kind === 'user')?.metrics?.spentYuan).toBe(failure.spentYuan)
    failed.stop()
    expect(failed.exportConversationState().spentYuan).toBe(failure.spentYuan)

    let release!: (reply: ModelReply) => void
    const stopping: ModelClient = { respond: (_history, _signal, _progress, _session, _tool, onTaskUsage) => {
      onTaskUsage?.(usage)
      return new Promise<ModelReply>((resolve) => { release = resolve })
    } }
    const stopped = new AgentRuntime(new NoteStore(testRoot), stopping)
    const run = stopped.sendMessage('停止轮')
    stopped.stop()
    const atStop = stopped.exportConversationState()
    release({ text: '迟到的回复' })
    await run
    expect(stopped.getSnapshot().taskStatus).toBe('cancelled')
    expect(stopped.exportConversationState().spentYuan).toBe(atStop.spentYuan)
    expect(stopped.exportConversationState().timeline.find((entry) => entry.kind === 'user')?.metrics?.spentYuan).toBe(atStop.spentYuan)
    expect(atStop.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
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

  it('replaces a failed ACP user message when the same text is sent again', async () => {
    let calls = 0
    const model = {
      respond: async () => {
        calls += 1
        if (calls === 1) throw new Error('DSH ACP 已退出（unknown）')
        return { text: '继续完成' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('同一条任务')
    expect(runtime.getSnapshot().taskStatus).toBe('failed')
    await runtime.sendMessage('同一条任务')
    const snapshot = runtime.getSnapshot()
    expect(snapshot.taskStatus).toBe('done')
    expect(snapshot.timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(snapshot.timeline.find((entry) => entry.kind === 'user')?.text).toBe('同一条任务')
  })

  it('keeps the persisted context reading when the live query is unavailable', async () => {
    const model = {
      respond: async () => ({ text: '完成' }),
      getContextUsage: async () => ({ status: 'unavailable' as const })
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const contextUsage = {
      status: 'available' as const, usedTokens: 558_806, maxTokens: 1_000_000,
      usedPercent: 55.9, remainingTokens: 441_194, checkedAt: '2026-10-23T07:13:47.673Z'
    }
    runtime.restoreConversation({
      id: 'large', title: '大会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [], pendingMessages: [], sdkSessionId: 'session-large', contextUsage
    })
    await expect(runtime.getContextUsage()).resolves.toMatchObject({
      status: 'available', usedTokens: 558_806, stale: true
    })
    expect(runtime.getSnapshot().contextUsage).toMatchObject({ status: 'available', usedTokens: 558_806, stale: true })
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
    expect(tools[0].tool).toMatchObject({
      toolUseId: 'read-1', name: 'Read', status: 'done', activity: 'reading', output: '文件已读取'
    })
    expect(runtime.getSnapshot().agentActivity).toBeUndefined()
  })

  it('lets a late result settle its existing tool row without reviving a finished turn', async () => {
    let emitTool!: NonNullable<Parameters<ModelClient['respond']>[4]>
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, onToolEvent) => {
        emitTool = onToolEvent!
        onToolEvent?.({ toolUseId: 'late-read', toolName: 'Read', phase: 'start', input: 'README.md' })
        return { text: '先给出最终回复' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('读取后回答')
    expect(runtime.getSnapshot().taskStatus).toBe('done')

    emitTool({ toolUseId: 'late-read', toolName: 'Read', phase: 'result', output: '迟到结果' })
    expect(runtime.getSnapshot()).toMatchObject({ taskStatus: 'done', avatarState: 'success' })
    expect(runtime.getSnapshot().agentActivity).toBeUndefined()
    expect(runtime.getSnapshot().timeline.find((entry) => entry.tool?.toolUseId === 'late-read')?.tool)
      .toMatchObject({ status: 'done', output: '迟到结果' })

    emitTool({ toolUseId: 'late-read', toolName: 'Read', phase: 'result', output: '重复结果不应覆盖' })
    expect(runtime.getSnapshot().timeline.find((entry) => entry.tool?.toolUseId === 'late-read')?.tool)
      .toMatchObject({ status: 'done', output: '迟到结果' })

    emitTool({ toolUseId: 'too-late', toolName: 'Bash', phase: 'start', input: 'echo late' })
    expect(runtime.getSnapshot().timeline.some((entry) => entry.tool?.toolUseId === 'too-late')).toBe(false)
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('exposes the active tool semantic while a tool is running, then clears it', async () => {
    let releaseTool!: () => void
    let releaseReply!: () => void
    let reportStarted!: () => void
    let reportResult!: () => void
    const toolStarted = new Promise<void>((resolve) => { reportStarted = resolve })
    const toolReleased = new Promise<void>((resolve) => { releaseTool = resolve })
    const resultEmitted = new Promise<void>((resolve) => { reportResult = resolve })
    const replyReleased = new Promise<void>((resolve) => { releaseReply = resolve })
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'read-live', toolName: 'custom_tool', kind: 'read', phase: 'start' })
        reportStarted()
        await toolReleased
        onToolEvent?.({ toolUseId: 'read-live', toolName: 'custom_tool', kind: 'read', phase: 'result', output: 'ok' })
        reportResult()
        await replyReleased
        return { text: '完成' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const run = runtime.sendMessage('读取')
    await toolStarted
    expect(runtime.getSnapshot()).toMatchObject({
      taskStatus: 'executing', avatarState: 'acting', agentActivity: 'reading'
    })
    releaseTool()
    await resultEmitted
    expect(runtime.getSnapshot().agentActivity).toBeUndefined()
    releaseReply()
    await run
    expect(runtime.getSnapshot().agentActivity).toBeUndefined()
  })

  it('falls back to the latest still-running tool when concurrent tools settle', async () => {
    const observed: Array<string | undefined> = []
    let runtime!: AgentRuntime
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'read-a', toolName: 'Read', kind: 'read', phase: 'start' })
        observed.push(runtime.getSnapshot().agentActivity)
        onToolEvent?.({ toolUseId: 'shell-b', toolName: 'Bash', kind: 'execute', phase: 'start' })
        observed.push(runtime.getSnapshot().agentActivity)
        onToolEvent?.({ toolUseId: 'shell-b', toolName: 'Bash', kind: 'execute', phase: 'result', output: 'ok' })
        observed.push(runtime.getSnapshot().agentActivity)
        onToolEvent?.({ toolUseId: 'read-a', toolName: 'Read', kind: 'read', phase: 'result', output: 'ok' })
        observed.push(runtime.getSnapshot().agentActivity)
        return { text: '完成' }
      }
    }
    runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('并发工具')
    expect(observed).toEqual(['reading', 'terminal', 'reading', undefined])
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

  it('restores the saved context usage so reopening a conversation is not "unknown"', () => {
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, {
      respond: async () => ({ text: 'ok' })
    } as ModelClient)
    const contextUsage = {
      status: 'available' as const,
      usedTokens: 214_000,
      maxTokens: 1_000_000,
      usedPercent: 21.4,
      remainingTokens: 786_000,
      checkedAt: '2026-10-23T04:00:00.000Z'
    }
    runtime.restoreConversation({
      id: 'usage', title: '用量会话', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [], pendingMessages: [], sdkSessionId: null, contextUsage
    })
    expect(runtime.getSnapshot().contextUsage).toMatchObject(contextUsage)
    expect(runtime.exportConversationState().contextUsage).toMatchObject(contextUsage)
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

describe('local goal loop for kernels without a goal driver', () => {
  it('continues until the model marks the goal done', async () => {
    const calls: string[] = []
    const model = {
      goalMode: 'local',
      respond: async (history: DialogueLine[]) => {
        calls.push(history[history.length - 1].content)
        return { text: calls.length === 1 ? '第一步完成' : '全部完成\n[[GOAL_DONE]]' }
      }
    } as ModelClient & { goalMode: string }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('/goal 完成改进')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    await vi.waitFor(() => expect(runtime.getSnapshot().goal ?? null).toBeNull())
    expect(calls[0]).toContain('目标：完成改进')
    expect(calls[1]).toContain('继续执行目标：完成改进')
    const timeline = runtime.getSnapshot().timeline
    expect(timeline.some((entry) => entry.text.includes('目标已完成'))).toBe(true)
    expect(timeline.some((entry) => entry.text.includes('[[GOAL_DONE]]'))).toBe(false)
  })

  it('clears a local goal without sending it to the model', async () => {
    const calls: string[] = []
    const model = {
      goalMode: 'local',
      respond: async () => {
        calls.push('called')
        return { text: '不应调用' }
      }
    } as ModelClient & { goalMode: string }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.restoreConversation({
      id: 'local-goal', title: '本地目标', createdAt: '', updatedAt: '', archivedAt: null, pinnedAt: null,
      mode: 'claude_code' as const, taskStatus: 'done' as const,
      timeline: [], history: [], pendingMessages: [], sdkSessionId: null,
      goal: { condition: '旧目标', phase: 'confirmed' as const, iterations: 1, startedAt: new Date().toISOString() }
    })
    await runtime.sendMessage('/goal clear')
    expect(calls).toHaveLength(0)
    expect(runtime.getSnapshot().goal ?? null).toBeNull()
  })

  it('keeps going past any iteration count instead of stopping', async () => {
    const calls: string[] = []
    let releaseSecond!: (reply: { text: string }) => void
    const model = {
      goalMode: 'local',
      respond: async () => {
        calls.push('called')
        if (calls.length === 1) return { text: '这一步还没完成' }
        return await new Promise<{ text: string }>((resolve) => { releaseSecond = resolve })
      }
    } as ModelClient & { goalMode: string }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.setGoalBudget(1, 0)
    await runtime.sendMessage('/goal 永远做不完')
    // 旧上限是 1 轮；现在会继续排下一轮，目标仍然在。
    await vi.waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2))
    expect(runtime.getSnapshot().goal).not.toBeNull()
    // 续轮不冒充用户，也不在每轮末尾补一行「继续执行目标」。
    expect(runtime.getSnapshot().timeline.some((entry) => entry.kind === 'system' && entry.text === '继续执行目标')).toBe(false)
    expect(runtime.getSnapshot().timeline.filter((entry) => entry.kind === 'user')).toHaveLength(1)
    expect(runtime.getSnapshot().timeline.some((entry) => entry.text.includes('轮上限'))).toBe(false)
    runtime.stop()
    releaseSecond({ text: '停下' })
  })
})

describe('plan mode and /goal truth', () => {
  it('keeps a cold plan-mode request unconfirmed until an SDK init callback arrives', async () => {
    let report!: (on: boolean) => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setPlanMode: async () => false,
      setPlanModeListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.setPlanMode(true)
    expect(runtime.getSnapshot().planMode).toBeUndefined()
    report(true)
    expect(runtime.getSnapshot().planMode).toBe(true)
  })
  it('carries a goal and plan mode through the saved record and back', async () => {
    const record = await new ConversationStore(testRoot).createConversation('保存', 'claude_code')
    const planted = { ...record, planMode: true, goal: {
      condition: '完成改进', phase: 'confirmed' as const, iterations: 2, startedAt: new Date().toISOString()
    } }
    const model: ModelClient = { respond: async () => ({ text: 'ok' }), setPlanMode: () => true }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.restoreConversation(planted)
    // Both come back on the snapshot: the goal still waits for CLI confirmation,
    // the plan-mode switch is on before the first turn rebuilds the query.
    expect(runtime.getSnapshot().goal).toMatchObject({ condition: '完成改进', phase: 'unverified', iterations: 2 })
    expect(runtime.getSnapshot().planMode).toBe(true)
    // And both flow back out — this is what persistConversation writes down.
    const exported = runtime.exportConversationState()
    expect(exported.goal).toMatchObject({ condition: '完成改进', iterations: 2 })
    expect(exported.planMode).toBe(true)
    // Clearing the goal must reach the record too (null, not "keep old").
    runtime.restoreConversation({ ...record })
    expect(runtime.exportConversationState().goal ?? null).toBeNull()
  })

  it('restores a saved goal as unverified until the CLI reports it again', async () => {
    const record = await new ConversationStore(testRoot).createConversation('目标', 'claude_code')
    const model: ModelClient = { respond: async () => ({ text: 'ok' }) }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.restoreConversation({ ...record, goal: {
      condition: '完成改进', phase: 'confirmed', iterations: 4, startedAt: new Date().toISOString()
    } })
    expect(runtime.getSnapshot().goal).toMatchObject({ condition: '完成改进', phase: 'unverified', iterations: 4 })
  })
  it('does not show plan mode until the model confirms the switch', async () => {
    let confirm!: () => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setPlanMode: () => new Promise<void>((resolve) => { confirm = resolve })
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const pending = runtime.setPlanMode(true)
    expect(runtime.getSnapshot().planMode).toBeUndefined()
    confirm()
    await pending
    expect(runtime.getSnapshot().planMode).toBe(true)
  })

  it('reports a rejected plan-mode control request without claiming success', async () => {
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setPlanMode: async () => { throw new Error('SDK refused') }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await expect(runtime.setPlanMode(true)).rejects.toThrow('SDK 未确认')
    expect(runtime.getSnapshot().planMode).toBeUndefined()
    expect(runtime.getSnapshot().timeline.at(-1)?.text).toContain('SDK 未确认')
  })

  it('switches the approval mode through the client and reports it in the snapshot', async () => {
    const switched = vi.fn(async () => true)
    const model: ModelClient = { respond: async () => ({ text: 'ok' }), setApprovalMode: switched }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.setApprovalMode('read-only')
    expect(switched).toHaveBeenCalledWith('read-only')
    expect(runtime.getSnapshot().approvalMode).toBe('read-only')
    expect(runtime.getSnapshot().planMode).toBe(true)
    await runtime.setApprovalMode('workspace-write')
    expect(switched).toHaveBeenCalledWith('workspace-write')
    expect(runtime.getSnapshot().approvalMode).toBe('workspace-write')
    expect(runtime.getSnapshot().planMode).toBe(false)
    expect(runtime.exportConversationState().approvalMode).toBe('workspace-write')
  })

  it('parks a tool permission on the snapshot and forwards the verdict', async () => {
    let report!: (request: { id: string; tool: string; summary: string; input: string } | null) => void
    const answered: Array<[string, boolean]> = []
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setApprovalMode: async () => true,
      setPermissionListener: (listener) => { report = listener },
      answerPermission: (id, allow) => { answered.push([id, allow]); return true }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    report({ id: 'p1', tool: 'Bash', summary: '执行命令：npm test', input: '{"command":"npm test"}' })
    expect(runtime.getSnapshot().permission).toMatchObject({ id: 'p1', tool: 'Bash' })
    await runtime.answerPermission('p1', true)
    expect(answered).toEqual([['p1', true]])
  })

  it('restores a saved approval mode, including records written before it existed', async () => {
    const record = await new ConversationStore(testRoot).createConversation('审批', 'claude_code')
    const current: ModelClient = { respond: async () => ({ text: 'ok' }), setApprovalMode: async () => true }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, current)
    runtime.restoreConversation({ ...record, approvalMode: 'acceptEdits' as unknown as ApprovalMode })
    expect(runtime.getSnapshot().approvalMode).toBe('workspace-write')
    // Legacy record: only the plan flag exists.
    const legacy: ModelClient = { respond: async () => ({ text: 'ok' }), setPlanMode: () => true }
    const restored = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, legacy)
    restored.restoreConversation({ ...record, planMode: true })
    expect(restored.getSnapshot().approvalMode).toBe('read-only')
    expect(restored.getSnapshot().planMode).toBe(true)
  })

  it('does not invent an iteration after a reply, then accepts SDK rounds and null clear', async () => {
    let report!: Parameters<NonNullable<ModelClient['setGoalListener']>>[0]
    const model: ModelClient = {
      respond: async () => ({ text: '完成一轮普通回复' }),
      setGoalListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('/goal 写完测试')
    expect(runtime.getSnapshot().goal).toMatchObject({ condition: '写完测试', phase: 'unverified' })
    expect(runtime.getSnapshot().goal?.iterations).toBeUndefined()
    report({ condition: '写完测试', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 2 })
    expect(runtime.getSnapshot().goal).toMatchObject({ phase: 'confirmed', iterations: 2 })
    report(null)
    expect(runtime.getSnapshot().goal).toBeNull()
  })

  it('ignores the confirmed iteration limit and wall-clock limits', async () => {
    let report!: Parameters<NonNullable<ModelClient['setGoalListener']>>[0]
    const model: ModelClient = {
      respond: async () => ({ text: '已接收' }),
      setGoalListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.setGoalBudget(3, 5)
    report({ condition: '轮数目标', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 3 })
    // 超过旧的 3 轮上限也不再暂停目标。
    expect(runtime.getSnapshot().goal?.phase).toBe('confirmed')
    expect(runtime.getQueuePauseReason()).toBeNull()
    runtime.resumeQueue()
    // Goals have no wall-clock budget: an old startedAt does not pause.
    report({ condition: '时间目标', phase: 'confirmed', startedAt: new Date(Date.now() - 6 * 60_000).toISOString(), iterations: 1 })
    expect(runtime.getSnapshot().goal?.phase).toBe('confirmed')
    expect(runtime.getQueuePauseReason()).toBeNull()
  })
})

describe('subagents, interactions and goal truth in the snapshot', () => {
  it('mirrors the SDK subagent set into the snapshot', () => {
    let report!: (tasks: SubagentTask[]) => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setSubagentTasksListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    report([{ taskId: 't1', description: '查资料', status: 'running', toolUses: 2, totalTokens: 900 }])
    expect(runtime.getSnapshot().subagents).toMatchObject([
      { taskId: 't1', description: '查资料', status: 'running', toolUses: 2, totalTokens: 900 }
    ])
    report([])
    expect(runtime.getSnapshot().subagents).toEqual([])
  })

  it('reports awaiting approval while any interaction is parked, then resumes', () => {
    let ask!: (question: AskQuestionRequest | null) => void
    let plan!: (plan: PlanApprovalRequest | null) => void
    let permission!: (request: { id: string; tool: string; summary: string; input: string } | null) => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setQuestionListener: (listener) => { ask = listener },
      setPlanListener: (listener) => { plan = listener },
      setPermissionListener: (listener) => { permission = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    ask({ id: 'q1', questions: [{ key: 'pick', question: '选哪个？', options: [], multiSelect: false }] })
    expect(runtime.getSnapshot().taskStatus).toBe('awaiting_approval')
    permission({ id: 'p1', tool: 'Bash', summary: '执行命令', input: '{}' })
    ask(null)
    // The permission is still parked: the turn is still waiting, not executing.
    expect(runtime.getSnapshot().taskStatus).toBe('awaiting_approval')
    plan({ id: 'pl1', plan: '1. 改配置\n2. 跑测试' })
    permission(null)
    expect(runtime.getSnapshot().taskStatus).toBe('awaiting_approval')
    plan(null)
    expect(runtime.getSnapshot().taskStatus).toBe('planning')
  })

  it('keeps the approved plan and persists leaving plan mode', async () => {
    let park!: (plan: PlanApprovalRequest | null) => void
    let modeListener!: (mode: ApprovalMode) => void
    let planListener!: (on: boolean) => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setApprovalMode: async () => true,
      setPlanListener: (listener) => { park = listener },
      answerPlan: () => { park(null); return true },
      setApprovalModeListener: (listener) => { modeListener = listener },
      setPlanModeListener: (listener) => { planListener = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.setApprovalMode('read-only')
    park({ id: 'p1', plan: '1. 改配置\n2. 跑测试' })
    await runtime.answerPlan('p1', true)
    expect(runtime.getSnapshot().approvedPlan).toContain('改配置')
    // The SDK client mirrors its own exit from plan mode through both listeners.
    modeListener('danger-full-access')
    planListener(false)
    expect(runtime.getSnapshot().planMode).toBe(false)
    expect(runtime.exportConversationState().approvalMode).toBe('danger-full-access')
  })

  it('carries the goal stop-hook reason into the snapshot without a budget pause', () => {
    let report!: (goal: AgentGoal | null) => void
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setGoalListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    report({ condition: '写完测试', phase: 'confirmed', startedAt: new Date().toISOString(),
      iterations: 2, lastReason: '还有 2 个用例未通过' })
    expect(runtime.getSnapshot().goal).toMatchObject({ iterations: 2, lastReason: '还有 2 个用例未通过' })
    runtime.setGoalBudget(2, 60)
    expect(runtime.getSnapshot().queuePauseReason ?? null).toBeNull()
  })

  it('does not clear a goal on old iteration counts', () => {
    let report!: (goal: AgentGoal | null) => void
    const clear = vi.fn()
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setGoalListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    runtime.setGoalClearHandler(clear)
    runtime.setGoalBudget(3, 5)
    report({ condition: '轮数目标', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 3 })
    expect(clear).not.toHaveBeenCalled()
    expect(runtime.getSnapshot().goal?.phase).toBe('confirmed')
  })

  it('rolls back a goal that never reached the CLI when the send fails', async () => {
    let report!: (goal: AgentGoal | null) => void
    const model: ModelClient = {
      respond: async () => { throw new Error('网络断开') },
      setGoalListener: (listener) => { report = listener }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    report({ condition: '旧目标', phase: 'confirmed', startedAt: new Date().toISOString(), iterations: 1 })
    await runtime.sendMessage('/goal 新目标')
    expect(runtime.getSnapshot().goal).toMatchObject({ condition: '旧目标', phase: 'confirmed' })
  })

  it('releases foreground subagents so a user message can be handled now', async () => {
    let report!: (tasks: SubagentTask[]) => void
    const background = vi.fn(async () => true)
    const model: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setSubagentTasksListener: (listener) => { report = listener },
      backgroundTask: background
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    report([{ taskId: 't1', description: '前台子代理', status: 'running' }])
    await runtime.releaseForegroundSubagents()
    expect(background).toHaveBeenCalledTimes(1)
    // Already backgrounded tasks do not need another control request.
    report([{ taskId: 't1', description: '前台子代理', status: 'running', isBackgrounded: true }])
    await runtime.releaseForegroundSubagents()
    expect(background).toHaveBeenCalledTimes(1)
  })

  it('第一段思考把“正在理解需求”的时间也算进去', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, _tool, _usage, onThinking) => {
        onThinking?.('想一下接下来怎么做', 0)
        return { text: '好了' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('帮我看看这个改动')
    const snapshot = runtime.getSnapshot()
    const thinking = snapshot.timeline.find((entry) => entry.kind === 'thinking')
    expect(thinking?.time).toBe(snapshot.taskMetrics?.startedAt)
    expect(thinking?.endedAt).toBeTruthy()
  })

  it('一次只允许一条待确认的插话，回显后才放行下一条', async () => {
    let finish!: (reply: { text: string }) => void
    const steers: string[] = []
    let echo!: (messageId: string) => void
    const model = {
      respond: () => new Promise<{ text: string }>((resolve) => { finish = resolve }),
      steer: async (text: string) => { steers.push(text); return { accepted: true, messageId: 'm1' } },
      setSteerEchoListener: (listener: (messageId: string) => void) => { echo = listener }
    } as ModelClient
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const running = runtime.sendMessage('开始')
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(true))

    await expect(runtime.steerMessage('第一条插话')).resolves.toBe(true)
    await expect(runtime.steerMessage('第二条插话')).resolves.toBe(false)
    expect(steers).toEqual(['第一条插话'])
    expect(runtime.getSnapshot().steering?.text).toBe('第一条插话')

    echo('m1')
    await expect(runtime.steerMessage('第二条插话')).resolves.toBe(true)
    expect(steers).toEqual(['第一条插话', '第二条插话'])

    finish({ text: '完成' })
    await running
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(false))
  })

  it('插话投递失败时提示，并让调用方把消息退回队列', async () => {
    let finish!: (reply: { text: string }) => void
    const model = {
      respond: () => new Promise<{ text: string }>((resolve) => { finish = resolve }),
      steer: async () => ({ accepted: false })
    } as ModelClient
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const running = runtime.sendMessage('开始')
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(true))

    await expect(runtime.steerMessage('插一句')).resolves.toBe(false)
    expect(runtime.getSnapshot().timeline.some((entry) => entry.kind === 'system' && entry.text.includes('插话未能投递'))).toBe(true)
    expect(runtime.getSnapshot().steering).toBeUndefined()

    finish({ text: '完成' })
    await running
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(false))
  })

  it('插话不打断当前生成，投递后原任务和新指令都留在上下文里', async () => {
    const replies: Array<(reply: ModelReply) => void> = []
    const histories: DialogueLine[][] = []
    let interrupts = 0
    const model = {
      respond: (history: DialogueLine[]) => {
        histories.push(structuredClone(history))
        return new Promise<ModelReply>((resolve) => replies.push(resolve))
      },
      steer: async () => ({ accepted: true, messageId: 'steer-1' }),
      interrupt: async () => { interrupts += 1 },
      setSteerEchoListener: () => undefined
    } as ModelClient
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const first = runtime.sendMessage('原始任务：做一个蓝色按钮')
    await vi.waitFor(() => expect(runtime.isRunning()).toBe(true))

    await expect(runtime.steerMessage('补充：按钮改成圆角')).resolves.toBe(true)
    // 关键语义：插话不是“取消这一轮”，生成仍在继续。
    expect(interrupts).toBe(0)
    expect(runtime.isRunning()).toBe(true)
    replies[0]({ text: '第一轮完成' })
    await first

    const second = runtime.sendMessage('继续')
    await vi.waitFor(() => expect(histories.length).toBe(2))
    const context = histories[1].map((line) => line.content).join('\n')
    expect(context).toContain('原始任务：做一个蓝色按钮')
    expect(context).toContain('补充：按钮改成圆角')
    expect(context).toContain('第一轮完成')
    replies[1]({ text: '第二轮完成' })
    await second
  })
})
