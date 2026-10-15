import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConversationStore, ConversationStoreError } from '../src/main/conversation-store'

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.resolve(projectRoot, '.cache', 'tests', `conversations-${randomUUID()}`)
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a test directory outside the project.')
  }
  await fs.rm(testRoot, { recursive: true, force: true })
})

/** Where one conversation's own file lives (v3 layout). */
function recordFile(root: string, id: string): string {
  return path.join(root, 'conversations', 'records', `${id}.json`)
}

describe('persistent conversation library', () => {
  it('forks one completed reply atomically into an independent cold conversation', async () => {
    const store = new ConversationStore(testRoot)
    const source = await store.createConversation('原会话', 'claude_code')
    const user = { id: randomUUID(), kind: 'user' as const, time: new Date().toISOString(), text: '请解释' }
    const reply = { id: randomUUID(), kind: 'assistant' as const, time: new Date().toISOString(), text: '这是答案' }
    await store.updateConversation(source.id, {
      taskStatus: 'done', timeline: [user, reply],
      history: [{ role: 'user', content: '请解释', sessionContext: '只供主进程使用的引用' },
        { role: 'assistant', content: '这是答案' }],
      sdkSessionId: 'original-sdk-session', compactionSummary: '旧会话摘要'
    })
    const sourceBefore = await store.getConversation(source.id)
    const write = vi.spyOn(store as unknown as { persist: (library: unknown) => Promise<void> }, 'persist')
    const child = await store.forkConversation(source.id, reply.id)
    expect(write).toHaveBeenCalledTimes(1)
    expect(child.id).not.toBe(source.id)
    expect(child.title).toBe('原会话 的续聊')
    expect(child.mode).toBe('claude_code')
    expect(child.taskStatus).toBe('idle')
    expect(child.sdkSessionId).toBeNull()
    expect(child.pendingMessages).toEqual([])
    expect(child.goal).toBeNull()
    expect(child.archivedAt).toBeNull()
    expect(child.pinnedAt).toBeNull()
    expect(child).not.toHaveProperty('compactionSummary')
    expect(child.timeline).toEqual(sourceBefore?.timeline)
    expect(child.history).toEqual(sourceBefore?.history)
    expect(child.history[0].sessionContext).toBe('只供主进程使用的引用')
    expect(await store.getConversation(source.id)).toEqual(sourceBefore)
    const reopened = new ConversationStore(testRoot)
    expect((await reopened.getState()).activeConversationId).toBe(child.id)
    expect((await reopened.getState()).settings.tabOrder[0]).toBe(child.id)
    expect((await reopened.getConversation(child.id))?.history).toEqual(sourceBefore?.history)
    await store.updateConversation(child.id, { history: [...child.history, { role: 'user', content: '继续' }] })
    expect((await store.getConversation(source.id))?.history).toEqual(sourceBefore?.history)
    await store.deleteConversation(source.id)
    expect((await new ConversationStore(testRoot).getConversation(child.id))?.timeline).toEqual(child.timeline)
  })

  it('rejects unfinished, archived, queued, stale and empty replies without creating a child', async () => {
    const store = new ConversationStore(testRoot)
    const source = await store.createConversation('原会话')
    const user = { id: randomUUID(), kind: 'user' as const, time: new Date().toISOString(), text: '问题' }
    const reply = { id: randomUUID(), kind: 'assistant' as const, time: new Date().toISOString(), text: '答案' }
    await store.updateConversation(source.id, { timeline: [user, reply],
      history: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }] })
    for (const taskStatus of ['idle', 'failed', 'cancelled', 'awaiting_approval'] as const) {
      await store.updateConversation(source.id, { taskStatus })
      await expect(store.forkConversation(source.id, reply.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    await store.updateConversation(source.id, { taskStatus: 'done', pendingMessages: [
      { id: randomUUID(), text: '尚未发送', attachments: [], createdAt: new Date().toISOString() }
    ] })
    await expect(store.forkConversation(source.id, reply.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await store.updateConversation(source.id, { pendingMessages: [] })
    await expect(store.forkConversation(source.id, 'stale-reply')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await store.updateConversation(source.id, { timeline: [user, { ...reply, text: ' ' }] })
    await expect(store.forkConversation(source.id, reply.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await store.updateConversation(source.id, { timeline: [user, reply], history: [{ role: 'user', content: '问题' }] })
    await expect(store.forkConversation(source.id, reply.id)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await store.archiveConversation(source.id)
    await expect(store.forkConversation(source.id, reply.id)).rejects.toMatchObject({ code: 'ARCHIVED_CONVERSATION' })
    expect((await new ConversationStore(testRoot).getState()).conversations).toHaveLength(1)
  })

  it('leaves no child or changed active tab when a fork write fails', async () => {
    const store = new ConversationStore(testRoot)
    const source = await store.createConversation('原会话')
    const user = { id: randomUUID(), kind: 'user' as const, time: new Date().toISOString(), text: '问题' }
    const reply = { id: randomUUID(), kind: 'assistant' as const, time: new Date().toISOString(), text: '答案' }
    await store.updateConversation(source.id, { taskStatus: 'done', timeline: [user, reply],
      history: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }] })
    const before = await fs.readFile(store.filePath, 'utf8')
    vi.spyOn(store as unknown as { persist: (library: unknown) => Promise<void> }, 'persist')
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(store.forkConversation(source.id, reply.id)).rejects.toThrow('disk unavailable')
    expect(await fs.readFile(store.filePath, 'utf8')).toBe(before)
    expect((await store.getState()).conversations).toHaveLength(1)
    const child = await store.forkConversation(source.id, reply.id)
    expect((await new ConversationStore(testRoot).getState()).activeConversationId).toBe(child.id)
  })

  it('applies a mixed batch in one write and reports every distinct skipped ID', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('第一段')
    const parked = await store.createConversation('有待发消息')
    const third = await store.createConversation('第三段')
    await store.updateConversation(parked.id, { pendingMessages: [
      { id: randomUUID(), text: '稍后发送', attachments: [], createdAt: new Date().toISOString() }
    ] })
    const write = vi.spyOn(store as unknown as { persist: (library: unknown) => Promise<void> }, 'persist')
    const result = await store.batchManageConversations('archive', [first.id, parked.id, first.id, third.id, 'missing'])
    expect(result.outcomes).toEqual([
      { id: first.id, status: 'updated' },
      { id: parked.id, status: 'skipped', reason: 'busy' },
      { id: third.id, status: 'updated' },
      { id: 'missing', status: 'skipped', reason: 'not_found' }
    ])
    expect(write).toHaveBeenCalledTimes(1)
    expect((await new ConversationStore(testRoot).getState()).activeConversationId).toBe(parked.id)
    expect((await store.batchManageConversations('pin', [parked.id, first.id])).outcomes).toEqual([
      { id: parked.id, status: 'updated' },
      { id: first.id, status: 'skipped', reason: 'archived' }
    ])
    expect((await store.batchManageConversations('pin', [parked.id])).outcomes).toEqual([
      { id: parked.id, status: 'skipped', reason: 'already_pinned' }
    ])
    expect((await store.batchManageConversations('unpin', [parked.id])).outcomes).toEqual([
      { id: parked.id, status: 'updated' }
    ])
    expect((await store.batchManageConversations('unpin', [parked.id])).outcomes).toEqual([
      { id: parked.id, status: 'skipped', reason: 'not_pinned' }
    ])
    expect((await store.batchManageConversations('archive', [first.id])).outcomes).toEqual([
      { id: first.id, status: 'skipped', reason: 'already_archived' }
    ])
    expect((await store.batchManageConversations('restore', [parked.id])).outcomes).toEqual([
      { id: parked.id, status: 'skipped', reason: 'busy' }
    ])
    expect(await store.batchManageConversations('delete', [])).toEqual({ action: 'delete', outcomes: [] })
    await expect(store.batchManageConversations('delete', Array(101).fill(first.id)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('keeps disk and memory unchanged if a batch write fails, then accepts a retry', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('保留一')
    const second = await store.createConversation('保留二')
    const before = await fs.readFile(store.filePath, 'utf8')
    vi.spyOn(store as unknown as { persist: (library: unknown) => Promise<void> }, 'persist')
      .mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(store.batchManageConversations('delete', [first.id, second.id])).rejects.toThrow('disk unavailable')
    expect(await fs.readFile(store.filePath, 'utf8')).toBe(before)
    expect((await store.getState()).conversations.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
    const retry = await store.batchManageConversations('delete', [first.id, second.id])
    expect(retry.outcomes).toEqual([
      { id: first.id, status: 'updated' }, { id: second.id, status: 'updated' }
    ])
    const state = await new ConversationStore(testRoot).getState()
    expect(state.conversations).toHaveLength(1)
    expect(state.activeConversationId).toBe(state.conversations[0].id)
  })

  it('persists bounded private session context only on user history lines', async () => {
    const store = new ConversationStore(testRoot)
    const session = await store.createConversation('引用目标')
    const context = 'x'.repeat(26 * 1024)
    await store.updateConversation(session.id, {
      history: [{ role: 'user', content: '可见问题', sessionContext: context }]
    })
    expect((await new ConversationStore(testRoot).getConversation(session.id))?.history[0].sessionContext).toBe(context)
    await expect(store.updateConversation(session.id, {
      history: [{ role: 'user', content: '可见问题', sessionContext: `${context}x` }]
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.updateConversation(session.id, {
      history: [{ role: 'assistant', content: '答复', sessionContext: '私有引用' }]
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('keeps stable task statuses and marks abandoned running tasks as cancelled after restart', async () => {
    const store = new ConversationStore(testRoot)
    const finished = await store.createConversation('完成的任务')
    const interrupted = await store.createConversation('中断的任务')
    await store.updateConversation(finished.id, { taskStatus: 'done' })
    await store.updateConversation(interrupted.id, { taskStatus: 'executing' })
    expect((await store.getState()).conversations.find((item) => item.id === interrupted.id)?.taskStatus).toBe('executing')

    const reopened = new ConversationStore(testRoot)
    const summaries = (await reopened.getState()).conversations
    expect(summaries.find((item) => item.id === finished.id)?.taskStatus).toBe('done')
    expect(summaries.find((item) => item.id === interrupted.id)?.taskStatus).toBe('cancelled')
    expect((await reopened.getConversation(interrupted.id))?.taskStatus).toBe('cancelled')
    expect(JSON.parse(await fs.readFile(recordFile(testRoot, interrupted.id), 'utf8')).taskStatus).toBe('executing')
    await expect(reopened.updateConversation(interrupted.id, { taskStatus: 'unexpected' as never }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('keeps unlimited conversations while five only controls the quick-switch display', async () => {
    const store = new ConversationStore(testRoot)
    const created = await Promise.all(Array.from({ length: 18 }, (_, index) =>
      store.createConversation(`会话 ${index + 1}`, 'claude_code')))

    expect((await store.getState()).settings.visibleConversationTabs).toBe(5)
    expect((await store.listConversations({ archived: false })).length).toBe(18)
    await store.updateConversation(created[0].id, {
      history: [{ role: 'user', content: '保存这段上下文' }],
      timeline: [{ id: 'entry-1', time: '11:00', kind: 'user', text: '保存这段上下文' }]
    })

    await store.archiveConversation(created[0].id)
    expect((await store.listConversations({ archived: false })).length).toBe(17)
    expect((await store.listConversations({ archived: true })).length).toBe(1)
    const additional = await store.createConversation('新增会话')
    await store.restoreConversation(created[0].id)

    const reopened = new ConversationStore(testRoot)
    expect((await reopened.getState()).activeConversationId).toBe(created[0].id)
    expect((await reopened.getConversation(created[0].id))?.history[0].content).toBe('保存这段上下文')
    expect((await reopened.listConversations()).length).toBe(19)
    expect((await reopened.getConversation(additional.id))?.title).toBe('新增会话')
    expect((await fs.readdir(path.dirname(store.filePath))).sort()).toEqual(['library.json', 'records'])
  })

  it('changes only the visible tab count without removing or blocking conversations', async () => {
    const store = new ConversationStore(testRoot)
    const sessions = await Promise.all(Array.from({ length: 5 }, () => store.createConversation()))
    await store.updateSettings({ visibleConversationTabs: 2 })

    expect((await store.listConversations({ archived: false })).length).toBe(5)
    expect((await new ConversationStore(testRoot).getState()).settings.visibleConversationTabs).toBe(2)
    await store.createConversation()
    expect((await store.listConversations({ archived: false })).length).toBe(6)
    for (const session of sessions.slice(0, 4)) await store.archiveConversation(session.id)
    expect((await store.listConversations({ archived: false })).length).toBe(2)
    await store.createConversation('新的会话')
    expect((await store.listConversations({ archived: false })).length).toBe(3)
    await expect(store.updateSettings({ visibleConversationTabs: 0 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.updateSettings({ visibleConversationTabs: 13 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('migrates v1 libraries without losing records, queues or SDK sessions', async () => {
    const old = new ConversationStore(testRoot)
    const created = await Promise.all(Array.from({ length: 8 }, (_, index) => old.createConversation(`旧会话 ${index}`)))
    await old.updateConversation(created[0].id, {
      pendingMessages: [{ id: 'pending', text: '继续执行', attachments: [], createdAt: '2026-10-01T00:00:00.000Z' }],
      sdkSessionId: 'sdk-session', history: [{ role: 'user', content: '历史内容' }]
    })
    // Hand-build a v1 single-file library out of the full records, the way an
    // old install would have looked.
    const fullRecords = []
    for (const session of created) {
      fullRecords.push(JSON.parse(await fs.readFile(recordFile(testRoot, session.id), 'utf8')))
    }
    const legacy = { version: 1, settings: { maxActiveConversations: 5 },
      activeConversationId: created.at(-1)!.id, conversations: fullRecords }
    for (const record of legacy.conversations) delete record.pinnedAt
    await fs.writeFile(old.filePath, JSON.stringify(legacy), 'utf8')

    const migrated = new ConversationStore(testRoot)
    // Fields the old file never had (thinking depth, profiles, display names…)
    // fall back to their defaults.
    expect((await migrated.getState()).settings).toEqual({
      visibleConversationTabs: 5, autoArchiveAfterDays: 0, effort: 'max',
      modelProfiles: [], activeModelProfileId: null, enableAutoTitleGeneration: true,
      showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
      userAvatar: null, assistantAvatar: null, tabOrder: [],
      goalMaxIterations: 30, goalMaxMinutes: 180, memoryEnabled: true
    })
    expect((await migrated.listConversations()).length).toBe(8)
    expect((await migrated.getConversation(created[0].id))?.pendingMessages[0].text).toBe('继续执行')
    expect((await migrated.getConversation(created[0].id))?.sdkSessionId).toBe('sdk-session')
    expect((await migrated.getConversation(created[0].id))?.history[0].content).toBe('历史内容')
    const onDisk = JSON.parse(await fs.readFile(old.filePath, 'utf8'))
    expect(onDisk.version).toBe(3)
    expect(onDisk.conversations).toHaveLength(8)
    expect(JSON.parse(await fs.readFile(recordFile(testRoot, created[0].id), 'utf8')).pinnedAt).toBeNull()
    // The old single file stays beside it as a backup.
    expect(await fs.stat(path.join(testRoot, 'conversations', 'library.v2.bak.json')).then(() => true)).toBe(true)
    await migrated.createConversation('迁移后继续创建')
    expect((await migrated.listConversations()).length).toBe(9)
  })

  it('sorts pinned sessions first and auto archives only idle unpinned sessions', async () => {
    const store = new ConversationStore(testRoot)
    const stale = await store.createConversation('闲置')
    const pinned = await store.createConversation('置顶')
    const pending = await store.createConversation('有待发消息')
    const current = await store.createConversation('当前')
    await store.setConversationPinned(pinned.id, true)
    await store.updateConversation(pending.id, { pendingMessages: [
      { id: 'pending', text: '继续执行', attachments: [], createdAt: '2026-10-01T00:00:00.000Z' }
    ] })
    await store.updateSettings({ autoArchiveAfterDays: 7 })
    for (const session of [stale, pinned, pending, current]) {
      const file = JSON.parse(await fs.readFile(recordFile(testRoot, session.id), 'utf8'))
      file.lastActivityAt = '2026-09-01T00:00:00.000Z'
      await fs.writeFile(recordFile(testRoot, session.id), JSON.stringify(file), 'utf8')
    }

    const reopened = new ConversationStore(testRoot)
    const result = await reopened.archiveInactiveConversations(new Date('2026-10-08T00:00:00.000Z'))
    expect(result.conversations.find((item) => item.id === stale.id)?.archivedAt).toBe('2026-10-08T00:00:00.000Z')
    expect(result.conversations.find((item) => item.id === pinned.id)?.archivedAt).toBeNull()
    expect(result.conversations.find((item) => item.id === pending.id)?.archivedAt).toBeNull()
    expect(result.conversations.find((item) => item.id === current.id)?.archivedAt).toBeNull()
    expect(result.conversations[0].id).toBe(pinned.id)
    await reopened.setConversationPinned(pinned.id, false)
    expect((await reopened.getConversation(pinned.id))?.pinnedAt).toBeNull()
    await expect(reopened.setConversationPinned(stale.id, true)).rejects.toMatchObject({ code: 'ARCHIVED_CONVERSATION' })
  })

  it('renames, searches by messages, restores, switches and deletes sessions', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('第一段对话')
    const second = await store.createConversation('第二段对话')
    await store.updateConversation(first.id, {
      title: '  项目 讨论  ',
      timeline: [{ id: 'e', time: '11:00', kind: 'assistant', text: '蓝鲸规划' }]
    })
    expect((await store.listConversations({ query: '项目' })).map((item) => item.id)).toEqual([first.id])
    expect((await store.listConversations({ query: '蓝鲸' })).map((item) => item.id)).toEqual([first.id])
    await store.archiveConversation(first.id)
    await expect(store.setActiveConversation(first.id)).rejects.toMatchObject({ code: 'ARCHIVED_CONVERSATION' })
    const restored = await store.restoreConversation(first.id)
    expect(restored.activeConversationId).toBe(first.id)
    await store.deleteConversation(first.id)
    expect((await store.getState()).activeConversationId).toBe(second.id)
    expect(await store.getConversation(first.id)).toBeNull()
    expect((await new ConversationStore(testRoot).listConversations()).map((item) => item.id)).toEqual([second.id])
  })

  it('previews the newest visible search hit without returning long or private content', async () => {
    const store = new ConversationStore(testRoot)
    const session = await store.createConversation('普通会话')
    await store.updateConversation(session.id, {
      timeline: [
        { id: 'old', time: '10:00', kind: 'assistant', text: `${'前文'.repeat(100)}\n  规划旧方案` },
        { id: 'new', time: '10:01', kind: 'user', text: `${'补充'.repeat(100)}\n  规划新方案，优先采用` },
        { id: 'tool', time: '10:02', kind: 'tool', text: '内部任务标记 sk-aaaaaaaaaaaaaaaaaaaa' },
        { id: 'last', time: '10:03', kind: 'assistant', text: '最新答复' }
      ],
      history: [
        { role: 'user', content: `${'历史'.repeat(100)}\n  历史线索`, sessionContext: '私有引用内容' },
        { role: 'assistant', content: '答复' }
      ]
    })

    expect((await store.listConversations())[0].preview).toBe('最新答复')
    const matched = (await store.listConversations({ query: '规划' }))[0].preview
    expect(matched).toContain('规划新方案')
    expect(matched).not.toContain('规划旧方案')
    expect(matched).toMatch(/^…/u)
    expect(matched.length).toBeLessThanOrEqual(160)
    expect(matched).not.toMatch(/[\r\n]/u)

    const historyMatch = (await store.listConversations({ query: '历史线索' }))[0].preview
    expect(historyMatch).toContain('历史线索')
    expect(historyMatch.length).toBeLessThanOrEqual(160)
    expect(await store.listConversations({ query: '私有引用内容' })).toEqual([])
    expect((await store.listConversations({ query: '内部任务标记' }))[0].preview).toBe('匹配了过程记录（思考或工具）')
    expect((await store.listConversations({ query: 'sk-aaaaaaaaaaaaaaaaaaaa' }))[0].preview).toBe('匹配了过程记录（思考或工具）')
  })

  it('keeps the latest preview for title hits and hides sensitive older messages', async () => {
    const store = new ConversationStore(testRoot)
    const session = await store.createConversation('鲸鱼方案')
    await store.updateConversation(session.id, {
      timeline: [
        { id: 'secret', time: '10:00', kind: 'user', text: '鲸鱼方案的密码是 sk-aaaaaaaaaaaaaaaaaaaa' },
        { id: 'last', time: '10:01', kind: 'assistant', text: '最新可见内容' }
      ]
    })
    expect((await store.listConversations({ query: '鲸鱼方案' }))[0].preview).toBe('最新可见内容')
    expect((await store.listConversations({ query: '密码' }))[0].preview).toBe('匹配了含敏感信息的消息')
  })

  it('stores complete model history and SDK context independently of a returned object', async () => {
    const store = new ConversationStore(testRoot)
    const session = await store.createConversation('技术实现', 'claude_code')
    const history = Array.from({ length: 101 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `第 ${index} 条消息`
    }))
    const updated = await store.updateConversation(session.id, {
      history,
      sdkSessionId: 'sdk-session-1',
      compactionSummary: '之前讨论了完整方案。',
      mode: 'live'
    })
    updated.history[0].content = '不能影响存储'
    history[1].content = '调用方修改'

    const reopened = await new ConversationStore(testRoot).getConversation(session.id)
    expect(reopened?.history).toHaveLength(101)
    expect(reopened?.history[0].content).toBe('第 0 条消息')
    expect(reopened?.history[1].content).toBe('第 1 条消息')
    expect(reopened?.sdkSessionId).toBe('sdk-session-1')
    expect(reopened?.compactionSummary).toBe('之前讨论了完整方案。')
    expect(reopened?.mode).toBe('live')
    await store.updateConversation(session.id, { compactionSummary: null, sdkSessionId: null })
    expect((await store.getConversation(session.id))?.compactionSummary).toBeUndefined()
    expect((await store.getConversation(session.id))?.sdkSessionId).toBeNull()
  })

  it('persists queued messages and supplies an empty queue when loading older records', async () => {
    const store = new ConversationStore(testRoot)
    const session = await store.createConversation('排队测试')
    const pendingMessages = [{
      id: 'pending-1',
      text: '下一条发送',
      attachments: [{ name: 'context.txt', content: '附件内容' }],
      createdAt: '2026-10-08T10:00:00.000Z'
    }]
    await store.updateConversation(session.id, { pendingMessages })
    pendingMessages[0].text = '调用方改动'
    expect((await new ConversationStore(testRoot).getConversation(session.id))?.pendingMessages[0].text).toBe('下一条发送')

    const oldFormat = JSON.parse(await fs.readFile(recordFile(testRoot, session.id), 'utf8'))
    delete oldFormat.pendingMessages
    await fs.writeFile(recordFile(testRoot, session.id), JSON.stringify(oldFormat), 'utf8')
    const migrated = new ConversationStore(testRoot)
    expect((await migrated.getConversation(session.id))?.pendingMessages).toEqual([])
  })

  it('preserves an invalid existing library instead of silently replacing it', async () => {
    const store = new ConversationStore(testRoot)
    await fs.mkdir(path.dirname(store.filePath), { recursive: true })
    await fs.writeFile(store.filePath, '{"version":1,"conversations":', 'utf8')
    await expect(store.initialize()).rejects.toBeInstanceOf(ConversationStoreError)
    expect(await fs.readFile(store.filePath, 'utf8')).toBe('{"version":1,"conversations":')
  })
})

describe('accrued conversation spend', () => {
  it('survives a reload instead of resetting with the process', async () => {
    const store = new ConversationStore(testRoot)
    const record = await store.createConversation('花了钱的会话', 'claude_code')
    const metrics = { startedAt: '2026-10-13T02:00:00.000Z', finishedAt: '2026-10-13T02:00:02.000Z',
      usedTokens: 42, usage: { total: 42, input: 30, output: 12 }, spentYuan: 0.4212 }
    await store.updateConversation(record.id, { spentYuan: 0.4212,
      timeline: [{ id: 'priced-user', kind: 'user', time: metrics.startedAt, text: '这个问题', metrics }] })
    // A fresh store reads the same file the way a restart would.
    const reopened = new ConversationStore(testRoot)
    expect((await reopened.getConversation(record.id))?.spentYuan).toBeCloseTo(0.4212, 6)
    expect((await reopened.getConversation(record.id))?.timeline[0].metrics).toEqual(metrics)
  })
})

describe('listing order follows activity, not edits', () => {
  it('keeps a session in place when it is renamed', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('一', 'claude_code')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.createConversation('二', 'claude_code')
    const before = (await store.getState()).conversations.map((item) => item.id)
    await store.updateConversation(before[1], { title: '改了名的' })
    const after = (await store.getState()).conversations.map((item) => item.id)
    expect(after).toEqual(before)
    expect(first.id).toBe(before[1])
  })

  it('moves a session to the front when a message lands in it', async () => {
    const store = new ConversationStore(testRoot)
    const older = await store.createConversation('旧的', 'claude_code')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.createConversation('新的', 'claude_code')
    await new Promise((resolve) => setTimeout(resolve, 20))
    await store.updateConversation(older.id, {
      timeline: [{ id: 'note', kind: 'system', text: '干过活', time: new Date().toISOString() }]
    })
    const after = (await store.getState()).conversations.map((item) => item.id)
    expect(after[0]).toBe(older.id)
  })
})

describe('search matches every word', () => {
  it('finds a message that has both words anywhere, in any order', async () => {
    const store = new ConversationStore(testRoot)
    const record = await store.createConversation('格式修正', 'claude_code')
    await store.updateConversation(record.id, {
      timeline: [{ id: 'u', kind: 'user', text: '先看范围，再改格式。', time: new Date().toISOString() }]
    })
    expect((await store.listConversations({ query: '范围 格式' })).map((item) => item.id)).toEqual([record.id])
    expect((await store.listConversations({ query: '格式 范围' })).map((item) => item.id)).toEqual([record.id])
    expect(await store.listConversations({ query: '范围 页码' })).toEqual([])
  })
})

describe('per-conversation storage', () => {
  it('isolates a damaged record so the rest of the library survives', async () => {
    const store = new ConversationStore(testRoot)
    const healthy = await store.createConversation('健康的', 'claude_code')
    const broken = await store.createConversation('坏掉的', 'claude_code')
    await store.updateConversation(healthy.id, {
      timeline: [{ id: 't', kind: 'user', text: '内容', time: new Date().toISOString() }]
    })
    await fs.writeFile(recordFile(testRoot, broken.id), '{ not json at all', 'utf8')

    const reopened = new ConversationStore(testRoot)
    const state = await reopened.getState()
    // Both rows stay in the list; only the damaged one loses its content.
    expect(state.conversations.map((item) => item.id).sort()).toEqual([healthy.id, broken.id].sort())
    expect((await reopened.getConversation(healthy.id))?.timeline).toHaveLength(1)
    expect((await reopened.getConversation(broken.id))?.timeline).toEqual([])
    expect((await reopened.getConversation(broken.id))?.title).toBe('坏掉的')
  })
})
