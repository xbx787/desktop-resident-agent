import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { AgentRuntime } from '../src/main/agent-runtime'
import type { DialogueLine, ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'
import { SideChatController, validateSideChatMessage } from '../src/main/side-chat'
import type { ConversationSettings, ConversationSummary } from '../src/shared/contracts'

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0,
  goalMaxIterations: 30, goalMaxMinutes: 180, memoryEnabled: false, effort: 'max',
  modelProfiles: [], activeModelProfileId: null, enableAutoTitleGeneration: false,
  showMessageTimestamps: true, userName: '用户', assistantName: '助手',
  userAvatar: null, assistantAvatar: null, tabOrder: []
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(model: ModelClient & { steer?: (text: string) => Promise<boolean> | boolean }) {
  let parentConversationId = 'parent-a'
  const runtimes: AgentRuntime[] = []
  const persistFlags: Array<boolean | undefined> = []
  const visibleEvents = vi.fn()
  const statusEvents = vi.fn()
  const history: DialogueLine[] = [
    { role: 'user', content: '主线问题' }, { role: 'assistant', content: '主线答案' }
  ]
  const side = new SideChatController(
    (onChange, persistSession) => {
      persistFlags.push(persistSession)
      const runtime = new AgentRuntime(new NoteStore(path.join(process.cwd(), '.cache', 'tests', 'side-chat-notes')),
        model, onChange, model)
      runtimes.push(runtime)
      return runtime
    },
    () => ({ parentConversationId, mode: 'claude_code', settings, history }),
    async () => '', visibleEvents, undefined,
    () => parentConversationId,
    () => settings,
    statusEvents
  )
  return { side, runtimes, persistFlags, history, visibleEvents, statusEvents,
    setParent: (id: string) => { parentConversationId = id } }
}

describe('temporary side chat', () => {
  it('seeds a separate runtime from settled dialogue and keeps its SDK client ephemeral', async () => {
    const seen: DialogueLine[][] = []
    const { side, runtimes, persistFlags, history } = harness({
      respond: async (lines) => {
        seen.push(structuredClone(lines))
        return { text: '侧聊答案', sdkSessionId: 'child-sdk' }
      }
    })
    const id = side.open().sessionId!
    expect(persistFlags).toEqual([false])
    expect(side.getSnapshot().snapshot?.timeline).toEqual([])
    await side.send(id, '侧聊问题')
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('done'))
    expect(seen[0].map(({ content }) => content)).toEqual(['主线问题', '主线答案', '侧聊问题'])
    expect(history).toEqual([
      { role: 'user', content: '主线问题' }, { role: 'assistant', content: '主线答案' }
    ])
    expect(runtimes[0].exportConversationState().sdkSessionId).toBe('child-sdk')
    expect(side.getSnapshot().snapshot?.timeline.map(({ text }) => text)).toEqual(['侧聊问题', '侧聊答案'])
    await side.discard(id)
    expect(side.getSnapshot().sessionId).toBeNull()
  })

  it('rejects empty and main-only commands before opening or queueing a child', async () => {
    expect(() => validateSideChatMessage('', [], 'claude_code')).toThrow('消息不能为空')
    expect(() => validateSideChatMessage('/goal 继续', [], 'claude_code')).toThrow('仅适用于主会话')
    expect(() => validateSideChatMessage('/compact', [], 'claude_code')).toThrow('仅适用于主会话')
    expect(() => validateSideChatMessage('/new 标题', [], 'claude_code')).toThrow('仅适用于主会话')
    expect(() => validateSideChatMessage('/side 问题', [], 'claude_code')).toThrow('已经在临时侧聊中')
    expect(() => validateSideChatMessage('', [{ name: 'file.docx', content: '', path: path.resolve('file.docx') }], 'live'))
      .toThrow('没有本地文件读取工具')
    expect(validateSideChatMessage('', [{ name: 'note.txt', content: '内容' }], 'live')).toBe('')
    const { side } = harness({ respond: async () => ({ text: 'ok' }) })
    await expect(side.openWithMessage('')).rejects.toThrow('消息不能为空')
    expect(side.getSnapshot().sessionId).toBeNull()
    const id = side.open().sessionId!
    await expect(side.send(id, '/compact')).rejects.toThrow('仅适用于主会话')
    expect(side.getSnapshot().pendingMessages).toEqual([])
    await side.discard(id)
  })

  it('restores a folded child when a slash send is rejected after reopening it', async () => {
    const { side } = harness({ respond: async () => ({ text: 'ok' }) })
    const id = side.open().sessionId!
    side.setModelMode(id, 'live')
    side.setExpanded(id, false)
    await expect(side.openWithMessage('', [{ name: 'file.docx', content: '', path: path.resolve('file.docx') }]))
      .rejects.toThrow('没有本地文件读取工具')
    expect(side.getSnapshot()).toMatchObject({ sessionId: id, expanded: false, pendingMessages: [] })
    await side.discard(id)
  })

  it('keeps a stopped queue paused and ignores a late reply before sending the resumed turn', async () => {
    const calls: Array<{ lines: DialogueLine[]; done: (reply: ModelReply) => void }> = []
    const { side } = harness({
      respond: (lines) => new Promise((done) => { calls.push({ lines: structuredClone(lines), done }) })
    })
    const id = side.open().sessionId!
    await side.send(id, '运行中')
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    await side.send(id, '原待发')
    side.stop(id)
    calls[0].done({ text: '迟到回复' })
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('cancelled'))
    expect(side.getSnapshot().pendingMessages.map(({ text }) => text)).toEqual(['原待发'])
    expect(side.getSnapshot().snapshot?.timeline.some(({ text }) => text === '迟到回复')).toBe(false)
    await side.send(id, '恢复后优先')
    await vi.waitFor(() => expect(calls).toHaveLength(2))
    expect(calls[1].lines.at(-1)?.content).toBe('恢复后优先')
    calls[1].done({ text: '恢复完成' })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls[2].lines.at(-1)?.content).toBe('原待发')
    calls[2].done({ text: '队列完成' })
    await vi.waitFor(() => expect(side.getSnapshot().pendingMessages).toEqual([]))
    await side.discard(id)
  })

  it('keeps inline attachment content when a queued message is edited and resent', async () => {
    const first = deferred<ModelReply>()
    const seen: DialogueLine[][] = []
    const { side } = harness({
      respond: (lines) => {
        seen.push(structuredClone(lines))
        return seen.length === 1 ? first.promise : Promise.resolve({ text: '已读附件' })
      }
    })
    const id = side.open().sessionId!
    side.setModelMode(id, 'live')
    await side.send(id, '先处理这条')
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    await side.send(id, '原问题', [{ name: 'note.txt', content: '附件正文' }])
    const queued = side.getSnapshot().pendingMessages[0]
    expect(queued.attachments).toEqual([{ name: 'note.txt', content: '附件正文' }])
    side.removeQueued(id, queued.id)
    await side.send(id, '修订问题', queued.attachments)
    first.resolve({ text: '第一条完成' })
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    expect(seen[1].at(-1)?.content).toContain('附件正文')
    await side.discard(id)
  })

  it('does not append guidance that resolves after stop', async () => {
    const reply = deferred<ModelReply>()
    const steer = deferred<boolean>()
    const { side, runtimes } = harness({ respond: () => reply.promise, steer: () => steer.promise })
    const id = side.open().sessionId!
    await side.send(id, '运行中')
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('planning'))
    const guidance = side.send(id, '晚到指引', [], 'steer')
    side.stop(id)
    steer.resolve(true)
    await expect(guidance).rejects.toThrow('已停止或关闭')
    expect(runtimes[0].exportConversationState().history.map(({ content }) => content)).not.toContain('晚到指引')
    reply.resolve({ text: '迟到回复' })
    await side.discard(id)
  })

  it('restores the claimed queue item after stop without deleting a different item', async () => {
    const reply = deferred<ModelReply>()
    const steer = deferred<boolean>()
    const { side } = harness({ respond: () => reply.promise, steer: () => steer.promise })
    const id = side.open().sessionId!
    await side.send(id, '运行中')
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('planning'))
    await side.send(id, '要转向')
    await side.send(id, '要移除')
    const [first, second] = side.getSnapshot().pendingMessages
    const steering = side.steerQueued(id, first.id)
    side.removeQueued(id, second.id)
    side.stop(id)
    steer.resolve(false)
    await steering
    expect(side.getSnapshot().pendingMessages.map(({ text }) => text)).toEqual(['要转向'])
    expect(side.getSnapshot().queuePaused).toBe(true)
    reply.resolve({ text: '迟到回复' })
    await side.discard(id)
  })

  it('keeps each parent side across A → B → A and rejects stale UI commands', async () => {
    const { side, setParent } = harness({ respond: async () => ({ text: '完成' }) })
    const aId = side.open().sessionId!
    await side.send(aId, 'A 问题')
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('done'))
    const aTimeline = side.getSnapshot().snapshot?.timeline
    setParent('parent-b')
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-b' })
    await expect(side.send(aId, '迟到发送')).rejects.toThrow('已关闭')
    await side.discard(aId)
    const bId = side.open().sessionId!
    expect(bId).not.toBe(aId)
    setParent('parent-a')
    expect(side.getSnapshot()).toMatchObject({ sessionId: aId, parentConversationId: 'parent-a' })
    expect(side.getSnapshot().snapshot?.timeline).toEqual(aTimeline)
    await side.discardAll()
  })

  it('runs A and B concurrently with isolated queues and offscreen timelines', async () => {
    const gates = new Map<string, ReturnType<typeof deferred<ModelReply>>>()
    const seen: string[] = []
    const { side, setParent, visibleEvents, statusEvents } = harness({ respond: (lines) => {
      const text = lines.at(-1)!.content
      seen.push(text)
      const gate = deferred<ModelReply>()
      gates.set(text, gate)
      return gate.promise
    } })
    const aId = side.open().sessionId!
    await side.send(aId, 'A 运行')
    await vi.waitFor(() => expect(seen).toContain('A 运行'))
    await side.send(aId, 'A 排队')
    setParent('parent-b')
    const bId = side.open().sessionId!
    await side.send(bId, 'B 运行')
    await vi.waitFor(() => expect(seen).toContain('B 运行'))
    expect(side.isBusy()).toBe(true)
    expect(side.isBusyForParent('parent-a')).toBe(true)
    expect(side.isBusyForParent('parent-b')).toBe(true)
    expect(side.statusForParent('parent-a')).not.toBeNull()
    setParent('parent-a')
    expect(side.getSnapshot().sessionId).toBe(aId)
    expect(side.getSnapshot().pendingMessages.map(({ text }) => text)).toEqual(['A 排队'])
    const visibleBeforeBReply = visibleEvents.mock.calls.length
    const statusBeforeBReply = statusEvents.mock.calls.length
    gates.get('B 运行')!.resolve({ text: 'B 答案' })
    await vi.waitFor(() => expect(side.isBusyForParent('parent-b')).toBe(false))
    expect(visibleEvents.mock.calls.length).toBe(visibleBeforeBReply)
    expect(statusEvents.mock.calls.length).toBeGreaterThan(statusBeforeBReply)
    expect(side.getSnapshot().snapshot?.timeline.some(({ text }) => text === 'B 答案')).toBe(false)
    gates.get('A 运行')!.resolve({ text: 'A 答案' })
    await vi.waitFor(() => expect(seen).toContain('A 排队'))
    gates.get('A 排队')!.resolve({ text: 'A 排队答案' })
    await vi.waitFor(() => expect(side.isBusy()).toBe(false))
    expect(side.getSnapshot().snapshot?.timeline.map(({ text }) => text)).toEqual(['A 运行', 'A 答案', 'A 排队', 'A 排队答案'])
    setParent('parent-b')
    expect(side.getSnapshot().sessionId).toBe(bId)
    expect(side.getSnapshot().snapshot?.timeline.map(({ text }) => text)).toEqual(['B 运行', 'B 答案'])
    await side.discardAll()
  })

  it('releases a removed parent while preserving the other side', async () => {
    const reply = deferred<ModelReply>()
    const { side, setParent } = harness({ respond: () => reply.promise })
    side.open()
    setParent('parent-b')
    const bId = side.open().sessionId!
    await side.send(bId, 'B 运行')
    await vi.waitFor(() => expect(side.isBusyForParent('parent-b')).toBe(true))
    setParent('parent-a')
    await side.discardParent('parent-b')
    expect(side.isBusyForParent('parent-b')).toBe(false)
    expect(side.getSnapshot().sessionId).not.toBeNull()
    setParent('parent-b')
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-b' })
    await expect(side.send(bId, '迟到消息')).rejects.toThrow('已关闭')
    reply.resolve({ text: 'B 迟到回复' })
    await side.discardAll()
  })

  it('releases all sides on global configuration change or quit and preserves the empty parent id', async () => {
    const { side, setParent } = harness({ respond: async () => ({ text: '完成' }) })
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-a' })
    const first = side.open().sessionId!
    setParent('parent-b')
    const second = side.open().sessionId!
    await side.discardAll()
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-b' })
    setParent('parent-a')
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-a' })
    expect(side.open().sessionId).not.toBe(first)
    setParent('parent-b')
    expect(side.open().sessionId).not.toBe(second)
    await side.discardAll()
  })

  it('prunes an idle child after its parent disappears from the library', async () => {
    const { side, setParent } = harness({ respond: async () => ({ text: '完成' }) })
    const aId = side.open().sessionId!
    setParent('parent-b')
    side.open()
    side.discardMissingParents(new Set(['parent-a']))
    expect(side.getSnapshot()).toMatchObject({ sessionId: null, parentConversationId: 'parent-b' })
    setParent('parent-a')
    expect(side.getSnapshot().sessionId).toBe(aId)
    await side.discardAll()
  })

  it('projects busy child status into library/search rows without masking active main work', async () => {
    const gate = deferred<ModelReply>()
    const { side } = harness({ respond: () => gate.promise })
    const id = side.open().sessionId!
    await side.send(id, '仍在侧聊')
    await vi.waitFor(() => expect(side.isBusyForParent('parent-a')).toBe(true))
    const summary: ConversationSummary = {
      id: 'parent-a', title: 'A', createdAt: '', updatedAt: '', lastActivityAt: '',
      archivedAt: null, pinnedAt: null, mode: 'claude_code', taskStatus: 'done', messageCount: 0, preview: ''
    }
    expect(side.withSideStatuses([summary])[0].taskStatus).toMatch(/planning|executing/)
    expect(side.withSideStatuses([{ ...summary, taskStatus: 'awaiting_approval' }])[0].taskStatus).toBe('awaiting_approval')
    expect(side.withSideStatuses([{ ...summary, id: 'parent-b' }])[0].taskStatus).toBe('done')
    gate.resolve({ text: '结束' })
    await vi.waitFor(() => expect(side.isBusyForParent('parent-a')).toBe(false))
    expect(side.withSideStatuses([summary])[0].taskStatus).toBe('done')
    await side.discardAll()
  })
})
