import { describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { AgentRuntime } from '../src/main/agent-runtime'
import type { DialogueLine, ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'
import { SideChatController, validateSideChatMessage } from '../src/main/side-chat'
import type { ConversationSettings } from '../src/shared/contracts'

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
    async () => '', undefined, undefined,
    () => parentConversationId,
    () => settings
  )
  return { side, runtimes, persistFlags, history, setParent: (id: string) => { parentConversationId = id } }
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

  it('discards on parent switch and rejects stale side operations', async () => {
    const reply = deferred<ModelReply>()
    const { side, setParent } = harness({ respond: () => reply.promise })
    const oldId = side.open().sessionId!
    await side.send(oldId, '旧侧聊')
    await vi.waitFor(() => expect(side.getSnapshot().snapshot?.taskStatus).toBe('planning'))
    setParent('parent-b')
    expect(side.getSnapshot().sessionId).toBeNull()
    await side.discard(oldId)
    const newId = side.open().sessionId!
    expect(newId).not.toBe(oldId)
    await side.discard(oldId)
    expect(side.getSnapshot().sessionId).toBe(newId)
    await expect(side.send(oldId, '迟到发送')).rejects.toThrow('已关闭')
    reply.resolve({ text: '旧侧聊迟到回复' })
    expect(side.getSnapshot().snapshot?.timeline).toEqual([])
    await side.discard(newId)
  })
})
