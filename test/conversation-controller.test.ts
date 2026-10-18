import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationController } from '../src/main/conversation-controller'
import { activeSideChatParentId } from '../src/main/side-chat'
import { ConversationStore } from '../src/main/conversation-store'
import type { ModelClient, ModelReply } from '../src/main/deepseek'
import type { ModelProfile } from '../src/shared/contracts'
import { sessionMentionToken } from '../src/shared/session-mentions'
import { NoteStore } from '../src/main/note-store'

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.join(projectRoot, '.cache', 'tests', `controller-${randomUUID()}`)
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.')
  // The store's write queue can still land a file while the tree is being
  // removed (ENOTEMPTY on Windows); retries are the documented remedy.
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

// Generous budget on purpose: this suite polls real timers, and a busy machine
// (parallel vitest workers, an in-flight electron-builder) can stretch a wait
// that normally takes milliseconds. A timeout here should mean "stuck".
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('conversation controller', () => {
  it.each(['archive', 'delete'] as const)('rejects an invisible side-chat parent after the last tab is %sd', async (action) => {
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const id = controller.displayedConversationId()!
    expect(activeSideChatParentId(id, controller.getSnapshot().conversationLibrary)).toBe(id)
    if (action === 'archive') await controller.archiveConversation(id)
    else await controller.deleteConversation(id)
    const library = controller.getSnapshot().conversationLibrary
    expect(library.activeConversationId).toBeNull()
    expect(activeSideChatParentId(controller.displayedConversationId(), library)).toBeNull()
  })

  it('changes the displayed epoch even after switching away and back to the same parent', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('第一条', 'demo')
    const second = await store.createConversation('第二条', 'demo')
    await store.setActiveConversation(first.id)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const epoch = controller.displayedConversationEpoch()
    await controller.selectConversation(second.id)
    await controller.selectConversation(first.id)
    expect(controller.displayedConversationId()).toBe(first.id)
    expect(controller.displayedConversationEpoch()).toBeGreaterThan(epoch)
  })

  it('notifies a tab switch only after its library and displayed record are ready', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('A', 'demo')
    const second = await store.createConversation('B', 'demo')
    await store.setActiveConversation(first.id)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const observed: Array<{ id: string | null; active: string | null; shown: string | null }> = []
    controller.setDisplayChangeListener((id) => {
      const snapshot = controller.getSnapshot()
      observed.push({ id, active: snapshot.conversationLibrary.activeConversationId,
        shown: activeSideChatParentId(controller.displayedConversationId(), snapshot.conversationLibrary) })
    })
    await controller.selectConversation(second.id)
    expect(observed.at(-1)).toEqual({ id: second.id, active: second.id, shown: second.id })
    await controller.archiveConversation(second.id)
    expect(observed.at(-1)).toEqual({ id: first.id, active: first.id, shown: first.id })
    await controller.archiveConversation(first.id)
    expect(observed.at(-1)).toEqual({ id: null, active: null, shown: null })
  })

  it('blocks single and bulk removal of a busy child and only targets its owner on model change', async () => {
    const store = new ConversationStore(testRoot)
    const a = await store.createConversation('A', 'demo')
    const b = await store.createConversation('B', 'demo')
    await store.setActiveConversation(a.id)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const busy = new Set([b.id])
    controller.setSideBusyPredicate((id) => busy.has(id))
    await expect(controller.archiveConversation(b.id)).rejects.toThrow('仍有任务')
    await expect(controller.deleteConversation(b.id)).rejects.toThrow('仍有任务')
    expect((await controller.batchManageConversations('archive', [b.id])).outcomes).toEqual([
      { id: b.id, status: 'skipped', reason: 'busy' }
    ])
    expect((await controller.batchManageConversations('delete', [b.id])).outcomes).toEqual([
      { id: b.id, status: 'skipped', reason: 'busy' }
    ])
    const configChanges: Array<string | undefined> = []
    controller.setRuntimeConfigurationChangeListener((id) => { configChanges.push(id) })
    await controller.setModelMode('demo', b.id)
    expect(configChanges).toEqual([b.id])
    await controller.updateSettings({ effort: 'high' })
    expect(configChanges).toEqual([b.id, undefined])
    busy.clear()
    await controller.archiveConversation(b.id)
    expect((await store.getConversation(b.id))?.archivedAt).not.toBeNull()
  })

  it('defers auto-archive while any side child is busy', async () => {
    const store = new ConversationStore(testRoot)
    const a = await store.createConversation('A', 'demo')
    const b = await store.createConversation('B', 'demo')
    await store.setActiveConversation(a.id)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const busy = new Set([b.id])
    controller.setSideBusyPredicate((id) => busy.has(id))
    await controller.updateSettings({ autoArchiveAfterDays: 7 })
    await controller.archiveInactiveConversations(new Date('2100-01-01T00:00:00.000Z'))
    expect((await store.getConversation(b.id))?.archivedAt).toBeNull()
    busy.clear()
    await controller.archiveInactiveConversations(new Date('2100-01-01T00:00:00.000Z'))
    expect((await store.getConversation(b.id))?.archivedAt).not.toBeNull()
  })

  it('seeds side chat only with committed, visible and nonsensitive turns', async () => {
    const store = new ConversationStore(testRoot)
    const record = await store.createConversation('主线', 'demo')
    const row = (id: string, kind: 'user' | 'assistant' | 'system', text: string) =>
      ({ id, kind, text, time: '2026-10-16T00:00:00.000Z' })
    await store.updateConversation(record.id, {
      taskStatus: 'planning',
      timeline: [
        row('u1', 'user', '安全问题'), row('a1', 'assistant', '安全答案'),
        row('u2', 'user', '已停止问题'), row('a2', 'assistant', '未完成的流式片段'),
        row('stop', 'system', '任务已停止'),
        row('u3', 'user', '后续问题'), row('a3', 'assistant', '后续答案'),
        row('u4', 'user', 'password 是私密内容'), row('a4', 'assistant', '不能复制'),
        row('u5', 'user', '正在运行'), row('a5', 'assistant', '还没结束')
      ],
      history: [
        { role: 'user', content: '安全问题' }, { role: 'assistant', content: '安全答案' },
        { role: 'user', content: '已停止问题' },
        { role: 'user', content: '后续问题' }, { role: 'assistant', content: '后续答案' },
        { role: 'user', content: 'password 是私密内容' }, { role: 'assistant', content: '不能复制' },
        { role: 'user', content: '正在运行' }
      ],
      sdkSessionId: 'main-sdk-session'
    })
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    expect(controller.captureSideChatHistory()).toEqual([
      { role: 'user', content: '安全问题' }, { role: 'assistant', content: '安全答案' },
      { role: 'user', content: '后续问题' }, { role: 'assistant', content: '后续答案' }
    ])
  })

  it('shows recorded turn metrics and total spend when opening a cold conversation', async () => {
    const store = new ConversationStore(testRoot)
    const cold = await store.createConversation('旧会话', 'claude_code')
    const metrics = { startedAt: '2026-10-13T02:00:00.000Z', finishedAt: '2026-10-13T02:00:02.000Z',
      usedTokens: 42, usage: { total: 42, input: 30, output: 12 }, spentYuan: 0.321 }
    await store.updateConversation(cold.id, { taskStatus: 'done', spentYuan: 0.321,
      timeline: [{ id: 'cold-user', kind: 'user', time: metrics.startedAt, text: '旧问题', metrics }] })
    await store.createConversation('当前会话', 'claude_code')
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    await controller.selectConversation(cold.id)
    const snapshot = controller.getSnapshot()
    expect(snapshot.mode).toBe('demo')
    expect(snapshot.timeline[0].metrics).toEqual(metrics)
    expect(snapshot.conversationSpentYuan).toBe(0.321)
    expect(snapshot.taskMetrics).toBeUndefined()
  })


  it('bulk updates idle sessions, preserves busy turns, and replaces an emptied active session', async () => {
    const calls: Array<(reply: ModelReply) => void> = []
    const model: ModelClient = { respond: () => new Promise((resolve) => { calls.push(resolve) }) }
    const store = new ConversationStore(testRoot)
    const active = await store.createConversation('运行中', 'live')
    const archived = await store.createConversation('已归档', 'live')
    const idle = await store.createConversation('可归档', 'live')
    await store.archiveConversation(archived.id)
    await store.setActiveConversation(active.id)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), model, onChange))
    await controller.initialize()
    await controller.sendMessage('仍在执行')
    await until(() => calls.length === 1 && controller.displayedRuntime()!.isRunning(), 'live turn')

    const result = await controller.batchManageConversations('archive',
      [active.id, archived.id, idle.id, active.id, 'missing'])
    expect(result.outcomes).toEqual([
      { id: active.id, status: 'skipped', reason: 'busy' },
      { id: archived.id, status: 'skipped', reason: 'already_archived' },
      { id: idle.id, status: 'updated' },
      { id: 'missing', status: 'skipped', reason: 'not_found' }
    ])
    expect(controller.getSnapshot().conversationLibrary.activeConversationId).toBe(active.id)
    expect(controller.getSnapshot().conversationLibrary.conversations.find((item) => item.id === idle.id)?.archivedAt).not.toBeNull()
    await expect(controller.sendMessage('不能发往已归档会话', [], 'queue', idle.id))
      .rejects.toMatchObject({ code: 'ARCHIVED_CONVERSATION' })
    expect((await controller.batchManageConversations('pin', [active.id])).outcomes).toEqual([
      { id: active.id, status: 'updated' }
    ])
    expect(controller.displayedRuntime()!.isRunning()).toBe(true)

    await controller.stop()
    calls[0]({ text: '迟到答复' })
    await until(() => controller.allConversationsIdle(), 'turn stopped')
    expect((await controller.batchManageConversations('delete', [active.id])).outcomes).toEqual([
      { id: active.id, status: 'updated' }
    ])
    const snapshot = controller.getSnapshot()
    const replacement = snapshot.conversationLibrary.activeConversationId!
    expect(replacement).not.toBe(active.id)
    expect(snapshot.conversationId).toBe(replacement)
    expect(snapshot.timeline).toEqual([])
    expect((await store.getConversation(replacement))?.archivedAt).toBeNull()
    expect((await store.getConversation(active.id))).toBeNull()
  })

  it('skips a conversation awaiting approval during a batch archive', async () => {
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const id = controller.getSnapshot().conversationId!
    await controller.setModelMode('demo')
    await controller.sendMessage('记录：审批前先不要写入')
    await until(() => controller.getSnapshot().taskStatus === 'awaiting_approval', 'approval state')
    expect((await controller.batchManageConversations('archive', [id])).outcomes).toEqual([
      { id, status: 'skipped', reason: 'busy' }
    ])
    expect((await store.getConversation(id))?.archivedAt).toBeNull()
  })

  it('keeps a stopped conversation with queued messages out of bulk deletion', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = { respond: () => new Promise((resolve) => { finish = resolve }) }
    const store = new ConversationStore(testRoot)
    const record = await store.createConversation('排队会话', 'live')
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), model, onChange))
    await controller.initialize()
    await controller.sendMessage('先处理')
    await until(() => Boolean(finish), 'first request')
    await controller.sendMessage('后处理')
    await controller.stop()
    expect(controller.getSnapshot().pendingMessages.map((message) => message.text)).toEqual(['后处理'])
    expect((await controller.batchManageConversations('delete', [record.id])).outcomes).toEqual([
      { id: record.id, status: 'skipped', reason: 'busy' }
    ])
    expect((await store.getConversation(record.id))?.pendingMessages).toHaveLength(1)
    finish({ text: '停止后返回' })
    await until(() => !controller.displayedRuntime()!.isRunning(), 'stopped request')
  })

  it('freezes a referenced conversation when queued and hides its snapshot from the renderer', async () => {
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = { respond: history => new Promise((resolve) => {
      calls.push({ text: history.at(-1)!.content, resolve })
    }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      onChange => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const sourceId = controller.getSnapshot().conversationLibrary.activeConversationId!
    await controller.sendMessage('源问题')
    await until(() => calls.length === 1, 'source request')
    calls[0].resolve({ text: '原始最终答复' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'source finished')

    const target = await controller.createConversation('目标会话')
    await controller.sendMessage('先处理这个任务')
    await until(() => calls.length === 2, 'target running')
    const token = sessionMentionToken('源会话', sourceId)
    await controller.sendMessage(`请参考 ${token}`)
    const queued = (await store.getConversation(target.id))!.pendingMessages[0]
    expect(queued.sessionContext).toContain('原始最终答复')
    expect(controller.getSnapshot().pendingMessages[0]).not.toHaveProperty('sessionContext')
    const source = (await store.getConversation(sourceId))!
    await store.updateConversation(sourceId, {
      timeline: source.timeline.map(entry => entry.kind === 'assistant' ? { ...entry, text: '后来修改的答复' } : entry),
      history: source.history.map(line => line.role === 'assistant' ? { ...line, content: '后来修改的答复' } : line)
    })
    calls[1].resolve({ text: '先前任务完成' })
    await until(() => calls.length === 3, 'queued referenced request')
    expect(calls[2].text).toContain('原始最终答复')
    expect(calls[2].text).not.toContain('后来修改的答复')
    calls[2].resolve({ text: '引用已处理' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'reference turn finished')
    const saved = (await store.getConversation(target.id))!
    expect(saved.history.some(line => line.role === 'user' && line.content.includes(token))).toBe(true)
    expect(saved.history.every(line => !line.content.includes('<referenced_conversations>'))).toBe(true)
    expect(saved.history.find(line => line.role === 'user' && line.content.includes(token))?.sessionContext)
      .toContain('原始最终答复')
    expect(JSON.stringify(controller.getSnapshot())).not.toContain('<referenced_conversations>')
  })

  it('delivers a referenced conversation through native steering while keeping visible history clean', async () => {
    const store = new ConversationStore(testRoot)
    const source = await store.createConversation('源会话', 'claude_code')
    await store.updateConversation(source.id, {
      timeline: [
        { id: randomUUID(), kind: 'user', time: new Date().toISOString(), text: '源问题' },
        { id: randomUUID(), kind: 'assistant', time: new Date().toISOString(), text: '源最终答复' }
      ],
      history: [{ role: 'user', content: '源问题' }, { role: 'assistant', content: '源最终答复' }]
    })
    await store.createConversation('目标会话', 'claude_code')
    let finish!: (reply: ModelReply) => void
    const guidance: string[] = []
    const model: ModelClient & { steer: (text: string) => boolean } = {
      respond: () => new Promise(resolve => { finish = resolve }),
      steer: text => { guidance.push(text); return true }
    }
    const controller = new ConversationController(store,
      onChange => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    await controller.sendMessage('正在进行的任务')
    await until(() => Boolean(finish), 'active target turn')
    const token = sessionMentionToken(source.title, source.id)
    await controller.sendMessage(`请结合 ${token}`, [], 'steer')
    expect(guidance).toHaveLength(1)
    expect(guidance[0]).toContain('源最终答复')
    expect(controller.displayedRuntime()!.exportConversationState().history.at(-1)?.content).toBe(`请结合 ${token}`)
    expect(controller.displayedRuntime()!.exportConversationState().history.at(-1)?.sessionContext).toContain('源最终答复')
    finish({ text: '完成' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'steered turn finished')
  })

  it('replays a frozen reference on a DeepSeek follow-up after restart and source deletion', async () => {
    const store = new ConversationStore(testRoot)
    const source = await store.createConversation('源会话', 'live')
    await store.updateConversation(source.id, {
      timeline: [
        { id: randomUUID(), kind: 'user', time: new Date().toISOString(), text: '源问题' },
        { id: randomUUID(), kind: 'assistant', time: new Date().toISOString(), text: '冻结的源答复' }
      ],
      history: [{ role: 'user', content: '源问题' }, { role: 'assistant', content: '冻结的源答复' }],
      taskStatus: 'done'
    })
    const target = await store.createConversation('目标会话', 'live')
    const calls: Array<Array<{ role: string; content: string }>> = []
    const model: ModelClient = { respond: async history => {
      calls.push(structuredClone(history))
      return { text: `目标答复 ${calls.length}` }
    } }
    const createController = (disk: ConversationStore) => new ConversationController(disk,
      onChange => new AgentRuntime(new NoteStore(testRoot), model, onChange))
    const first = createController(store)
    await first.initialize()
    const token = sessionMentionToken(source.title, source.id)
    await first.sendMessage(`请参考 ${token}`)
    await until(() => calls.length === 1 && first.getSnapshot().taskStatus === 'done', 'first reference reply')
    const saved = (await store.getConversation(target.id))!
    expect(saved.history[0].content).toBe(`请参考 ${token}`)
    expect(saved.history[0].sessionContext).toContain('冻结的源答复')
    await first.deleteConversation(source.id)

    const reopened = createController(new ConversationStore(testRoot))
    await reopened.initialize()
    await reopened.sendMessage('刚才引用的结论是什么？')
    await until(() => calls.length === 2 && reopened.getSnapshot().taskStatus === 'done', 'follow-up reply')
    expect(calls[1][0].content).toContain('冻结的源答复')
    expect(calls[1][0].content).toContain('<referenced_conversations>')
    expect(calls[1].at(-1)?.content).toBe('刚才引用的结论是什么？')
    expect(JSON.stringify(reopened.getSnapshot())).not.toContain('冻结的源答复')
    expect(JSON.stringify(reopened.getSnapshot())).not.toContain('<referenced_conversations>')
  })

  it('adds updated memory to the next queued model request without storing it in chat history', async () => {
    const calls: string[] = []
    const resolves: Array<(reply: ModelReply) => void> = []
    const model: ModelClient = { respond: (history) => new Promise((resolve) => {
      calls.push(history.at(-1)!.content)
      resolves.push(resolve)
    }) }
    let memory = ''
    const controller = new ConversationController(new ConversationStore(testRoot),
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    controller.setTurnHooks({
      memoryContext: async () => memory,
      afterSuccessfulTurn: async () => { memory = '用户喜欢蓝色。' }
    })
    await controller.initialize()
    await controller.sendMessage('第一条')
    await until(() => calls.length === 1, 'first memory-free request')
    await controller.sendMessage('第二条')
    resolves[0]({ text: '已完成第一条' })
    await until(() => calls.length === 2, 'next request with updated memory')
    expect(calls[0]).not.toContain('用户喜欢蓝色')
    expect(calls[1]).toContain('用户喜欢蓝色')
    expect(calls[1]).toContain('第二条')
    const history = controller.displayedRuntime()!.exportConversationState().history
    expect(JSON.stringify(history)).not.toContain('用户喜欢蓝色')
    resolves[1]({ text: '已完成第二条' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'second finished turn')
  })
  it('exposes the active run status on its tab immediately and keeps completed tabs distinct', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = { respond: () => new Promise((resolve) => { finish = resolve }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const firstId = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('处理第一段')
    await until(() => Boolean(finish), 'running model call')
    expect(controller.getSnapshot().conversationLibrary.conversations.find((item) => item.id === firstId)?.taskStatus)
      .toBe('planning')
    expect((await controller.listConversations()).find((item) => item.id === firstId)?.taskStatus).toBe('planning')

    finish({ text: '处理完成' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'completed task')
    const second = await controller.createConversation('第二段')
    const summaries = controller.getSnapshot().conversationLibrary.conversations
    expect(summaries.find((item) => item.id === firstId)?.taskStatus).toBe('done')
    expect(summaries.find((item) => item.id === second.id)?.taskStatus).toBe('idle')
  })

  it('does not promise binary file reading in the direct DeepSeek mode', async () => {
    const direct: ModelClient = { respond: async () => ({ text: 'should not run' }) }
    const controller = new ConversationController(new ConversationStore(testRoot), (onChange) => new AgentRuntime(new NoteStore(testRoot), direct, onChange))
    await controller.initialize()
    await expect(controller.sendMessage('分析文档', [
      { name: 'draft.docx', content: '', path: path.join(testRoot, 'draft.docx') }
    ])).rejects.toThrow('请切换到小鲸引擎模式')
  })

  it('uses native steer inside the current turn and preserves the queued follow-up', async () => {
    const calls: string[] = []
    const guidance: string[] = []
    const resolves: Array<(reply: ModelReply) => void> = []
    const model: ModelClient & { steer: (text: string) => boolean } = {
      respond: (history) => new Promise((resolve) => {
        calls.push(history.at(-1)!.content)
        resolves.push(resolve)
      }),
      steer: (text) => { guidance.push(text); return true }
    }
    const controller = new ConversationController(new ConversationStore(testRoot), (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    await controller.sendMessage('任务 A')
    await until(() => calls.length === 1, 'native turn')
    await controller.sendMessage('排队 B')
    await controller.sendMessage('阶段引导 C', [], 'steer')
    expect(guidance).toEqual(['阶段引导 C'])
    expect(calls).toEqual(['任务 A'])
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['排队 B'])
    resolves[0]({ text: '已按 C 引导完成 A' })
    await until(() => calls.length === 2, 'queued follow-up')
    expect(calls[1]).toBe('排队 B')
    resolves[1]({ text: 'B 完成' })
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === 'B 完成'), 'second reply')
    expect(controller.getSnapshot().timeline.some((item) => item.kind === 'user' && item.text === '阶段引导 C')).toBe(true)
  })

  it('applies Claudian-style idle archiving at startup while keeping the current and pinned sessions', async () => {
    const store = new ConversationStore(testRoot)
    const stale = await store.createConversation('闲置会话')
    const pinned = await store.createConversation('置顶会话')
    const current = await store.createConversation('正在查看')
    await store.setConversationPinned(pinned.id, true)
    await store.updateSettings({ autoArchiveAfterDays: 7 })
    for (const session of [stale, pinned, current]) {
      const file = path.join(testRoot, 'conversations', 'records', `${session.id}.json`)
      const record = JSON.parse(await fs.readFile(file, 'utf8'))
      record.lastActivityAt = '2020-01-01T00:00:00.000Z'
      await fs.writeFile(file, JSON.stringify(record), 'utf8')
    }

    const reopened = new ConversationStore(testRoot)
    const controller = new ConversationController(reopened, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const summary = controller.getSnapshot().conversationLibrary.conversations
    expect(summary.find((item) => item.id === stale.id)?.archivedAt).not.toBeNull()
    expect(summary.find((item) => item.id === pinned.id)?.archivedAt).toBeNull()
    expect(summary.find((item) => item.id === current.id)?.archivedAt).toBeNull()
    expect(summary[0].id).toBe(pinned.id)
    await controller.setConversationPinned(pinned.id, false)
    expect(controller.getSnapshot().conversationLibrary.conversations[0].id).toBe(current.id)
  })

  it('acknowledges queued sends before model completion, drains in order and persists each conversation', async () => {
    const calls: Array<{ text: string; sdkSessionId: string | null | undefined; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = {
      respond: (history, _signal, _onProgress, sdkSessionId) => new Promise((resolve) => {
        calls.push({ text: history[history.length - 1].content, sdkSessionId, resolve })
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    const first = await controller.sendMessage('第一条')
    await until(() => calls.length === 1, 'first model call')
    const second = await controller.sendMessage('第二条')
    expect(first.id).not.toBe(second.id)
    expect(calls).toHaveLength(1)
    expect((await store.getConversation(id))?.pendingMessages.map((item) => item.text)).toEqual(['第二条'])

    calls[0].resolve({ text: '第一条答复', sdkSessionId: 'sdk-1' })
    await until(() => calls.length === 2, 'second model call')
    expect(calls[1].text).toBe('第二条')
    expect(calls[1].sdkSessionId).toBe('sdk-1')
    calls[1].resolve({ text: '第二条答复', sdkSessionId: 'sdk-1' })
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === '第二条答复'), 'final reply')
    await until(() => controller.allConversationsIdle(), 'final reply persisted')
    const saved = await new ConversationStore(testRoot).getConversation(id)
    expect(saved?.history.map((item) => item.content)).toEqual(['第一条', '第一条答复', '第二条', '第二条答复'])
    expect(saved?.sdkSessionId).toBe('sdk-1')
    expect(saved?.title).toBe('第一条')
  })

  it('refines the first-line fallback into a model-generated title in the background', async () => {
    let resolveTitle!: (value: string | null) => void
    const sources: string[] = []
    const model: ModelClient = { respond: async () => ({ text: '答复' }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model), undefined, undefined, (source) => {
      sources.push(source)
      return new Promise((resolve) => { resolveTitle = resolve })
    })
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('帮我整理一下项目文档')
    await until(() => sources.length === 1, 'title request')
    expect(sources[0]).toBe('帮我整理一下项目文档')
    expect((await store.getConversation(id))?.title).toBe('帮我整理一下项目文档')
    resolveTitle('整理项目文档')
    await until(() => controller.getSnapshot().conversationLibrary.conversations
      .find((item) => item.id === id)?.title === '整理项目文档', 'refined title')
    expect((await store.getConversation(id))?.title).toBe('整理项目文档')
  })

  it('never lets a late generated title override a manual rename', async () => {
    let resolveTitle!: (value: string | null) => void
    const model: ModelClient = { respond: async () => ({ text: '答复' }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model), undefined, undefined, () =>
      new Promise((resolve) => { resolveTitle = resolve }))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('帮我整理一下项目文档')
    await until(() => Boolean(resolveTitle), 'title request')
    await controller.renameConversation(id, '我自己的名字')
    resolveTitle('模型起的名字')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await store.getConversation(id))?.title).toBe('我自己的名字')
  })

  it('keeps the fallback when title generation fails', async () => {
    const model: ModelClient = { respond: async () => ({ text: '答复' }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model), undefined, undefined, async () => null)
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('帮我整理一下项目文档')
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect((await store.getConversation(id))?.title).toBe('帮我整理一下项目文档')
  })

  it('prioritizes steering after the active turn when native steering is unavailable', async () => {
    const calls: string[] = []
    const finish = new Map<string, (reply: ModelReply) => void>()
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        const text = history[history.length - 1].content
        calls.push(text)
        finish.set(text, resolve)
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('第一条')
    await until(() => calls.length === 1, 'first running turn')
    await controller.sendMessage('旧排队消息')
    await controller.sendMessage('立刻执行这条', [], 'steer')
    expect(calls).toEqual(['第一条'])
    expect(controller.getSnapshot().taskStatus).toBe('planning')
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['立刻执行这条', '旧排队消息'])
    expect((await store.getConversation(id))?.pendingMessages.map((item) => item.text)).toEqual(['立刻执行这条', '旧排队消息'])
    finish.get('第一条')!({ text: '原答复' })
    await until(() => calls.length === 2, 'priority queued turn')
    expect(calls).toEqual(['第一条', '立刻执行这条'])
    finish.get('立刻执行这条')!({ text: '优先队列答复' })
    await until(() => calls.length === 3, 'older queued turn')
    expect(calls).toEqual(['第一条', '立刻执行这条', '旧排队消息'])
    finish.get('旧排队消息')!({ text: '队列答复' })
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === '队列答复'), 'queued reply')
    await until(() => controller.allConversationsIdle(), 'queued reply persisted')
    expect((await store.getConversation(id))?.pendingMessages).toEqual([])
    expect((await store.getConversation(id))?.history.map((item) => item.content)).toEqual([
      '第一条', '原答复', '立刻执行这条', '优先队列答复', '旧排队消息', '队列答复'
    ])
    expect((await store.getConversation(id))?.history.some((item) => item.content === '旧排队消息')).toBe(true)
  })

  it('queues guidance when a Claude Code turn declines native steering', async () => {
    const calls: string[] = []
    const resolves: Array<(reply: ModelReply) => void> = []
    const model: ModelClient & { steer: () => boolean } = {
      respond: (history) => new Promise((resolve) => {
        calls.push(history.at(-1)!.content)
        resolves.push(resolve)
      }),
      steer: () => false
    }
    const controller = new ConversationController(
      new ConversationStore(testRoot),
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model)
    )
    await controller.initialize()
    await controller.sendMessage('运行 A')
    await until(() => calls.length === 1, 'active Claude turn')
    await controller.sendMessage('普通队列 B')
    await controller.sendMessage('优先引导 C', [], 'steer')
    expect(calls).toEqual(['运行 A'])
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['优先引导 C', '普通队列 B'])
    resolves[0]({ text: 'A 完成' })
    await until(() => calls.length === 2, 'priority guidance')
    expect(calls[1]).toBe('优先引导 C')
    resolves[1]({ text: 'C 完成' })
    await until(() => calls.length === 3, 'older queue')
    resolves[2]({ text: 'B 完成' })
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === 'B 完成'), 'queue completion')
  })

  it('steers a queued message into the running turn and takes it out of the queue', async () => {
    let finish!: (reply: ModelReply) => void
    const steered: string[] = []
    const model: ModelClient & { steer: (text: string) => Promise<boolean> } = {
      respond: () => new Promise((resolve) => { finish = resolve }),
      steer: async (text: string) => { steered.push(text); return true }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('第一条')
    await until(() => Boolean(finish), 'running turn')
    const queued = await controller.sendMessage('排队的话')
    await controller.steerQueued(queued.id)
    expect(steered).toEqual(['排队的话'])
    expect(controller.getSnapshot().pendingMessages).toEqual([])
    expect((await store.getConversation(id))?.pendingMessages).toEqual([])
    finish({ text: '答复' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'completed turn')
  })

  it('moves a queued message to the front when steering is unavailable, and refuses unknown ids', async () => {
    const calls: string[] = []
    const resolutions: Array<(reply: ModelReply) => void> = []
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        calls.push(history.at(-1)!.content)
        resolutions.push(resolve)
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()

    await controller.sendMessage('第一条')
    await until(() => calls.length === 1, 'running turn')
    await controller.sendMessage('普通排队')
    const later = await controller.sendMessage('想插队的')
    await controller.steerQueued(later.id)
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['想插队的', '普通排队'])
    await expect(controller.steerQueued('missing')).rejects.toThrow('找不到这条待发送消息')
    resolutions[0]({ text: '答复' })
    await until(() => calls.length === 2, 'front message sent')
    expect(calls[1]).toBe('想插队的')
    resolutions[1]({ text: '答复 2' })
    await until(() => calls.length === 3, 'older message sent')
    expect(calls[2]).toBe('普通排队')
    resolutions[2]({ text: '答复 3' })
    await until(() => controller.getSnapshot().pendingMessages.length === 0, 'drained queue')
  })

  it('shows pending messages after restart without executing them until the user sends again', async () => {
    const disk = new ConversationStore(testRoot)
    const existing = await disk.createConversation('重启前', 'claude_code')
    await disk.updateConversation(existing.id, { pendingMessages: [{
      id: 'waiting-1', text: '旧待发消息', attachments: [], createdAt: new Date().toISOString()
    }] })
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        calls.push({ text: history[history.length - 1].content, resolve })
      })
    }
    const controller = new ConversationController(
      new ConversationStore(testRoot),
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model)
    )
    await controller.initialize()
    await new Promise((resolve) => setTimeout(resolve, 15))
    expect(calls).toEqual([])
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['旧待发消息'])

    await controller.sendMessage('新消息')
    await until(() => calls.length === 1, 'resumed queue')
    expect(calls[0].text).toBe('旧待发消息')
    calls[0].resolve({ text: '旧回复' })
    await until(() => calls.length === 2, 'following new message')
    calls[1].resolve({ text: '新回复' })
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === '新回复'), 'new reply')
  })

  it('keeps archived conversation history separate and can remove one waiting message', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = {
      respond: () => new Promise((resolve) => { finish = resolve })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const firstId = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('运行中')
    await until(() => controller.displayedRuntime()!.isRunning(), 'running turn')
    const queued = await controller.sendMessage('不要发送')
    await controller.removeQueued(queued.id)
    expect(controller.getSnapshot().pendingMessages).toEqual([])
    await controller.stop()
    finish({ text: '迟到答复' })
    await until(() => !controller.displayedRuntime()!.isRunning(), 'stopped turn')
    await until(() => controller.getSnapshot().timeline.some((item) => item.text.includes('已停止思考')), 'stop status')
    const first = await store.getConversation(firstId)
    expect(first?.history.some((item) => item.content === '不要发送')).toBe(false)

    await until(() => controller.getSnapshot().pendingMessages.length === 0, 'stopped queue')
    const second = await controller.createConversation('第二段')
    expect(controller.getSnapshot().timeline).toEqual([])
    await controller.selectConversation(firstId)
    expect(controller.getSnapshot().timeline.length).toBeGreaterThan(0)
    await controller.archiveConversation(firstId)
    expect(controller.getSnapshot().conversationLibrary.activeConversationId).toBe(second.id)
    expect((await controller.listConversations({ archived: true })).map((item) => item.id)).toContain(firstId)
    await controller.restoreConversation(firstId)
    expect(controller.getSnapshot().conversationLibrary.activeConversationId).toBe(firstId)
  })
})

describe('stopped queue', () => {
  it('keeps pending messages on disk and resumes only after a new explicit send', async () => {
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        calls.push({ text: history.at(-1)?.content ?? '', resolve })
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!
    await controller.sendMessage('正在处理')
    await until(() => calls.length === 1, 'first running turn')
    await controller.sendMessage('保留在队列')
    await controller.stop()
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['保留在队列'])
    expect((await store.getConversation(id))?.pendingMessages.map((item) => item.text)).toEqual(['保留在队列'])
    calls[0].resolve({ text: '迟到回复' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toHaveLength(1)
    await controller.sendMessage('/goal clear')
    await until(() => calls.length === 2, 'clear command while paused')
    expect(calls[1].text).toBe('/goal clear')
    calls[1].resolve({ text: '目标已清除' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(calls).toHaveLength(2)
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['保留在队列'])
    await controller.sendMessage('现在继续')
    await until(() => calls.length === 3, 'explicit resume')
    expect(calls[2].text).toBe('现在继续')
    calls[2].resolve({ text: '继续完成' })
    await until(() => calls.length === 4, 'old pending after resume')
    expect(calls[3].text).toBe('保留在队列')
    calls[3].resolve({ text: '排队完成' })
    await until(() => controller.getSnapshot().pendingMessages.length === 0, 'drained after resume')
  })
})

describe('model profiles', () => {
  const profile = (id: string, name: string): ModelProfile => ({
    id, name, baseUrl: 'https://api.example.test/anthropic', apiKey: 'sk-x', model: 'm'
  })

  it('materializes the launch environment as the first profile when none exists', async () => {
    const seed: ModelProfile = { id: 'default', name: 'DeepSeek', baseUrl: 'https://api.example.test/anthropic', apiKey: 'sk-env', model: 'm' }
    const first = new ConversationController(new ConversationStore(testRoot), (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, { respond: async () => ({ text: 'ok' }) }), () => {}, () => {}, undefined, seed)
    await first.initialize()
    expect(first.getSnapshot().conversationLibrary.settings.modelProfiles.map((item) => item.name)).toEqual(['DeepSeek'])
    expect(first.getSnapshot().conversationLibrary.settings.activeModelProfileId).toBe('default')

    // A later boot with profiles already present must not seed again.
    const again = new ConversationController(new ConversationStore(testRoot), (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, { respond: async () => ({ text: 'ok' }) }), () => {}, () => {}, undefined, { ...seed, id: 'other', name: '重复' })
    await again.initialize()
    expect(again.getSnapshot().conversationLibrary.settings.modelProfiles.map((item) => item.name)).toEqual(['DeepSeek'])
  })

  it('activates the first saved profile, switches explicitly, and falls back after delete', async () => {
    const applied: Array<unknown> = []
    const sdk: ModelClient = {
      respond: async () => ({ text: 'ok' }),
      setProvider: (provider) => { applied.push(provider) }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, sdk))
    await controller.initialize()

    await controller.saveModelProfile(profile('p1', '一号'))
    expect(applied.at(-1)).toMatchObject({ model: 'm', apiKey: 'sk-x' })
    expect(controller.getSnapshot().conversationLibrary.settings.activeModelProfileId).toBe('p1')

    // A second profile must not steal the active slot.
    await controller.saveModelProfile(profile('p2', '二号'))
    expect(controller.getSnapshot().conversationLibrary.settings.activeModelProfileId).toBe('p1')
    expect(controller.getSnapshot().conversationLibrary.settings.modelProfiles.map((item) => item.name)).toEqual(['一号', '二号'])

    await controller.setModelProfile('p2')
    expect(controller.getSnapshot().conversationLibrary.settings.activeModelProfileId).toBe('p2')

    await controller.deleteModelProfile('p2')
    expect(controller.getSnapshot().conversationLibrary.settings.activeModelProfileId).toBeNull()
    expect(applied.at(-1)).toBeUndefined()

    // The choice survives a reload through the store.
    const reloaded = new ConversationController(new ConversationStore(testRoot), (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, { respond: async () => ({ text: 'ok' }) }))
    await reloaded.initialize()
    expect(reloaded.getSnapshot().conversationLibrary.settings.modelProfiles.map((item) => item.name)).toEqual(['一号'])
  })

  it('preserves a saved secret on same-endpoint edits but requires a new key when endpoint changes', async () => {
    const controller = new ConversationController(new ConversationStore(testRoot), (onChange) =>
      new AgentRuntime(new NoteStore(testRoot), undefined, onChange, { respond: async () => ({ text: 'ok' }) }))
    await controller.initialize()
    await controller.saveModelProfile({ ...profile('p1', 'Original'), extraEnv: 'CUSTOM_TOKEN=secret' })
    await controller.saveModelProfile({ ...profile('p1', 'Renamed'), apiKey: '', extraEnv: undefined })
    expect(controller.getSnapshot().conversationLibrary.settings.modelProfiles[0]).toMatchObject({
      name: 'Renamed', apiKey: 'sk-x', extraEnv: 'CUSTOM_TOKEN=secret'
    })
    await expect(controller.saveModelProfile({ ...profile('p1', 'Wrong endpoint'), baseUrl: 'https://different.example.test', apiKey: '' }))
      .rejects.toThrow('重新输入 API Key')
    expect(controller.getSnapshot().conversationLibrary.settings.modelProfiles[0]?.baseUrl).toBe('https://api.example.test/anthropic')
  })
})

describe('idle direct send', () => {
  it('starts an idle message straight away without ever showing it in the waiting strip', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = { respond: () => new Promise((resolve) => { finish = resolve }) }
    const store = new ConversationStore(testRoot)
    const queuedSeen: number[] = []
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model), () => {
      queuedSeen.push(controller.getSnapshot().pendingMessages.length)
    })
    await controller.initialize()
    queuedSeen.length = 0
    await controller.sendMessage('空闲直发')
    await until(() => Boolean(finish), 'running model call')
    // Every snapshot the renderer heard about had an empty queue: the message
    // never flashed through the waiting strip before becoming a message.
    expect(queuedSeen.every((count) => count === 0)).toBe(true)
    expect(controller.getSnapshot().pendingMessages).toEqual([])
    finish({ text: '完成' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'completed task')
  })

  it('still picks up messages queued during a seeded idle turn', async () => {
    const finishes: Array<(reply: ModelReply) => void> = []
    const calls: string[] = []
    const model: ModelClient = {
      respond: (history) => {
        calls.push(history.at(-1)?.content ?? '')
        return new Promise((resolve) => finishes.push(resolve))
      }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    await controller.sendMessage('第一条')
    await until(() => calls.length === 1, 'first call')
    await controller.sendMessage('排队中')
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['排队中'])
    finishes[0]({ text: '一完成' })
    await until(() => calls.length === 2, 'second call')
    expect(controller.getSnapshot().pendingMessages).toEqual([])
    finishes[1]({ text: '二完成' })
    await until(() => controller.getSnapshot().taskStatus === 'done', 'all done')
    expect(calls).toEqual(['第一条', '排队中'])
  })
})

describe('parallel conversations', () => {
  it('switches display while a conversation keeps running, and both drain independently', async () => {
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        calls.push({ text: history[history.length - 1].content, resolve })
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const aId = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('A 的任务')
    await until(() => calls.length === 1, 'A running')

    // Switching display while A runs must not throw and must not stop A.
    const b = await controller.createConversation('B 会话')
    expect(controller.getSnapshot().conversationId).toBe(b.id)
    expect(calls).toHaveLength(1)

    // B runs in parallel on its own runtime.
    await controller.sendMessage('B 的任务')
    await until(() => calls.length === 2, 'B running')
    expect(calls.map((call) => call.text)).toEqual(['A 的任务', 'B 的任务'])

    // Both tabs show live status through the library summaries.
    let library = controller.getSnapshot().conversationLibrary.conversations
    expect(library.find((item) => item.id === aId)?.taskStatus).toBe('planning')
    expect(library.find((item) => item.id === b.id)?.taskStatus).toBe('planning')

    // A finishes while B stays displayed; its reply lands in A only.
    calls[0].resolve({ text: 'A 答复' })
    await until(() => controller.getSnapshot().conversationLibrary.conversations
      .find((item) => item.id === aId)?.taskStatus === 'done', 'A done')
    expect(controller.getSnapshot().timeline.some((item) => item.text === 'A 答复')).toBe(false)

    await controller.selectConversation(aId)
    expect(controller.getSnapshot().timeline.some((item) => item.text === 'A 答复')).toBe(true)
    expect(controller.getSnapshot().conversationLibrary.conversations
      .find((item) => item.id === b.id)?.taskStatus).toBe('planning')

    calls[1].resolve({ text: 'B 答复' })
    await until(() => controller.getSnapshot().conversationLibrary.conversations
      .find((item) => item.id === b.id)?.taskStatus === 'done', 'B done')
    await controller.selectConversation(b.id)
    await until(() => controller.getSnapshot().timeline.some((item) => item.text === 'B 答复'), 'B reply')

    const savedA = await store.getConversation(aId)
    const savedB = await store.getConversation(b.id)
    expect(savedA?.history.map((item) => item.content)).toEqual(['A 的任务', 'A 答复'])
    expect(savedB?.history.map((item) => item.content)).toEqual(['B 的任务', 'B 答复'])
  })

  it('keeps the pending queue per conversation', async () => {
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const model: ModelClient = {
      respond: (history) => new Promise((resolve) => {
        calls.push({ text: history[history.length - 1].content, resolve })
      })
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const aId = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('A1')
    await until(() => calls.length === 1, 'A1 running')
    await controller.sendMessage('A2')
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['A2'])

    // A fresh conversation starts with an empty queue; its idle send dispatches
    // straight away and never shows in a waiting strip.
    const b = await controller.createConversation('B')
    expect(controller.getSnapshot().pendingMessages).toEqual([])
    await controller.sendMessage('B1')
    await until(() => calls.length === 2, 'B1 running')
    expect(controller.getSnapshot().pendingMessages).toEqual([])

    // Switching back shows A's queue untouched.
    await controller.selectConversation(aId)
    expect(controller.getSnapshot().pendingMessages.map((item) => item.text)).toEqual(['A2'])

    calls.find((call) => call.text === 'A1')!.resolve({ text: 'A1 答复' })
    await until(() => calls.some((call) => call.text === 'A2'), 'A2 dispatched')
    calls.find((call) => call.text === 'A2')!.resolve({ text: 'A2 答复' })
    await until(() => controller.getSnapshot().pendingMessages.length === 0, 'A drained')
    calls.find((call) => call.text === 'B1')!.resolve({ text: 'B1 答复' })
    await until(() => controller.getSnapshot().conversationLibrary.conversations
      .find((item) => item.id === b.id)?.taskStatus === 'done', 'B done')
  })

  it('ends a goal by interrupting the loop and sending /goal clear as its own turn', async () => {
    const calls: Array<{ text: string; resolve: (reply: ModelReply) => void }> = []
    const interrupted = vi.fn()
    const model: ModelClient & { interrupt: () => Promise<void> } = {
      respond: (history) => new Promise((resolve) => {
        const last = history[history.length - 1]
        calls.push({ text: typeof last.content === 'string' ? last.content : '', resolve })
      }),
      interrupt: async () => { interrupted() }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()

    await controller.sendMessage('/goal 完成测试')
    await until(() => controller.getSnapshot().goal?.condition === '完成测试', '目标被记录')
    await until(() => controller.displayedRuntime()!.isRunning(), '目标回合运行中')

    await controller.clearGoal()
    // The loop's turn is interrupted first; the command itself never travels
    // as steered conversation, and it waits behind the running turn.
    expect(interrupted).toHaveBeenCalled()
    expect(controller.getSnapshot().timeline.some((entry) => entry.kind === 'user' && entry.text === '/goal clear')).toBe(false)

    // Once the turn winds down the queued command runs as its own turn — that
    // is the shape the CLI executes as a command instead of plain text.
    calls[0]!.resolve({ text: '目标回合答复' })
    await until(() => calls.some((call) => call.text.includes('/goal clear')), '清目标命令作为新回合发出')
    expect(controller.getSnapshot().goal?.phase).toBe('stopping')
  })

  it('writes a goal to disk as soon as it appears, before its turn ends', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = { respond: () => new Promise((resolve) => { finish = resolve }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('/goal 立刻落盘')
    await until(() => controller.displayedRuntime()!.getGoal()?.condition === '立刻落盘', '目标被记录')
    // The turn is still hanging (respond never resolved): the goal must already
    // be on disk — closing the window mid-loop would otherwise lose it.
    expect(controller.displayedRuntime()!.isRunning()).toBe(true)
    let stored: string | undefined
    const deadline = Date.now() + 5_000
    while (stored !== '立刻落盘' && Date.now() < deadline) {
      stored = (await store.getConversation(id))?.goal?.condition
      if (stored !== '立刻落盘') await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(stored).toBe('立刻落盘')
    finish({ text: '答复' })
  })

  it('keeps the composer draft on disk so a restart never loses it', async () => {
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.saveDraft(id, '写到一半的话')
    expect(await controller.getDraft(id)).toBe('写到一半的话')

    // A fresh controller (the restart) reads the same text back.
    const revived = new ConversationController(new ConversationStore(testRoot),
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await revived.initialize()
    expect(await revived.getDraft(id)).toBe('写到一半的话')

    // Sending clears it — the empty draft is a real value, not a missing one.
    await revived.saveDraft(id, '')
    expect(await revived.getDraft(id)).toBe('')
  })

  it('still refuses to delete a conversation while it is running', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = { respond: () => new Promise((resolve) => { finish = resolve }) }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store, (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.getSnapshot().conversationLibrary.activeConversationId!

    await controller.sendMessage('运行中')
    await until(() => controller.displayedRuntime()!.isRunning(), 'running turn')
    await expect(controller.deleteConversation(id)).rejects.toThrow('仍有任务')
    await expect(controller.archiveConversation(id)).rejects.toThrow('仍有任务')
    await controller.stop()
    finish({ text: '答复' })
    await until(() => !controller.displayedRuntime()!.isRunning(), 'stopped')
  })
})
