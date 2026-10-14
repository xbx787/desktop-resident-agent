import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

describe('persistent conversation library', () => {
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
    expect(JSON.parse(await fs.readFile(store.filePath, 'utf8')).conversations
      .find((item: { id: string }) => item.id === interrupted.id).taskStatus).toBe('cancelled')
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
    expect(await fs.readdir(path.dirname(store.filePath))).toEqual(['library.json'])
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
    const legacy = JSON.parse(await fs.readFile(old.filePath, 'utf8'))
    legacy.version = 1
    legacy.settings = { maxActiveConversations: 5 }
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
    expect(onDisk.version).toBe(2)
    expect(onDisk.conversations).toHaveLength(8)
    expect(onDisk.conversations[0].pinnedAt).toBeNull()
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
    const file = JSON.parse(await fs.readFile(store.filePath, 'utf8'))
    for (const record of file.conversations) record.updatedAt = '2026-09-01T00:00:00.000Z'
    await fs.writeFile(store.filePath, JSON.stringify(file), 'utf8')

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

    const oldFormat = JSON.parse(await fs.readFile(store.filePath, 'utf8'))
    delete oldFormat.conversations[0].pendingMessages
    await fs.writeFile(store.filePath, JSON.stringify(oldFormat), 'utf8')
    const migrated = new ConversationStore(testRoot)
    expect((await migrated.getConversation(session.id))?.pendingMessages).toEqual([])
    expect(JSON.parse(await fs.readFile(store.filePath, 'utf8')).conversations[0].pendingMessages).toEqual([])
  })

  it('preserves an invalid existing library instead of silently replacing it', async () => {
    const store = new ConversationStore(testRoot)
    await fs.mkdir(path.dirname(store.filePath), { recursive: true })
    await fs.writeFile(store.filePath, '{"version":1,"conversations":', 'utf8')
    await expect(store.initialize()).rejects.toBeInstanceOf(ConversationStoreError)
    expect(await fs.readFile(store.filePath, 'utf8')).toBe('{"version":1,"conversations":')
  })
})
