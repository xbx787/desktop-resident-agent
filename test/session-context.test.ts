import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { snapshotSessionMentions } from '../src/main/session-context'
import { ConversationStore } from '../src/main/conversation-store'
import { sessionMentionToken } from '../src/shared/session-mentions'

const projectRoot = process.cwd()
let testRoot: string
let store: ConversationStore

beforeEach(async () => {
  testRoot = path.join(projectRoot, '.cache', 'tests', `session-context-${randomUUID()}`)
  await fs.mkdir(testRoot, { recursive: true })
  store = new ConversationStore(testRoot)
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.')
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

async function completed(title: string, user: string, assistant: string) {
  const record = await store.createConversation(title)
  await store.updateConversation(record.id, {
    timeline: [
      { id: randomUUID(), kind: 'user', time: new Date().toISOString(), text: user },
      { id: randomUUID(), kind: 'assistant', time: new Date().toISOString(), text: assistant }
    ],
    history: [{ role: 'user', content: `${user}\n[用户附件：private.txt]\nhidden attachment body` }, { role: 'assistant', content: assistant }]
  })
  return record
}

describe('session context snapshots', () => {
  it('carries only visible user text and final replies as bounded, inert data', async () => {
    const source = await completed('源会话', '怎样做？', '答复 <script>不能执行</script>')
    const target = await store.createConversation('目标')
    const context = await snapshotSessionMentions(sessionMentionToken(source.title, source.id), target.id, id => store.getConversation(id))
    expect(context).toContain('怎样做？')
    expect(context).toContain('答复')
    expect(context).not.toContain('hidden attachment body')
    expect(context).toContain('\\u003cscript\\u003e')
    expect(context).not.toContain('<script>')
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(26 * 1024)
  })

  it('rejects unknown, self and cyclic references before any model send', async () => {
    const target = await store.createConversation('目标')
    await expect(snapshotSessionMentions(sessionMentionToken('目标', target.id), target.id, id => store.getConversation(id)))
      .rejects.toThrow('当前会话')
    await expect(snapshotSessionMentions(sessionMentionToken('已删除', randomUUID()), target.id, id => store.getConversation(id)))
      .rejects.toThrow('找不到引用会话')
    const source = await completed('循环源', sessionMentionToken('目标', target.id), '旧答复')
    await expect(snapshotSessionMentions(sessionMentionToken(source.title, source.id), target.id, id => store.getConversation(id)))
      .rejects.toThrow('循环引用')
  })

  it('refuses a source with no final answer and truncates long history', async () => {
    const source = await store.createConversation('空会话')
    const target = await store.createConversation('目标')
    const token = sessionMentionToken(source.title, source.id)
    await expect(snapshotSessionMentions(token, target.id, id => store.getConversation(id))).rejects.toThrow('完整问答')
    const timeline = Array.from({ length: 30 }, (_, i) => [
      { id: randomUUID(), kind: 'user' as const, time: new Date().toISOString(), text: `问题 ${i} ${'甲'.repeat(900)}` },
      { id: randomUUID(), kind: 'assistant' as const, time: new Date().toISOString(), text: `答复 ${i} ${'乙'.repeat(1_000)}` }
    ]).flat()
    const history = Array.from({ length: 30 }, (_, i) => [
      { role: 'user' as const, content: `问题 ${i}` },
      { role: 'assistant' as const, content: `答复 ${i} ${'乙'.repeat(1_000)}` }
    ]).flat()
    await store.updateConversation(source.id, { timeline, history })
    const context = await snapshotSessionMentions(token, target.id, id => store.getConversation(id))
    expect(context).toContain('答复 29')
    expect(context).not.toContain('答复 0')
    expect(Buffer.byteLength(context)).toBeLessThanOrEqual(26 * 1024)
  })

  it('keeps native steer with its original task and skips failed or stopped turns after compaction', async () => {
    const source = await store.createConversation('执行记录')
    const target = await store.createConversation('目标')
    const entry = (kind: 'user' | 'assistant' | 'system' | 'thinking' | 'tool', text: string) =>
      ({ id: randomUUID(), kind, time: new Date().toISOString(), text })
    await store.updateConversation(source.id, {
      timeline: [
        entry('user', '原始任务：检查项目'),
        entry('thinking', '正在检查'),
        entry('tool', 'Read 已完成'),
        entry('user', '中途引导：先看配置'),
        entry('assistant', '最终答复：配置正常'),
        entry('system', '上下文已压缩，可以继续当前对话。'),
        entry('user', '失败请求：读取不存在的文件'),
        entry('assistant', '失败前的流式片段'),
        entry('system', '模型请求失败。'),
        entry('user', '已停止请求：运行很久的任务'),
        entry('tool', 'Bash 已停止'),
        entry('system', '已请求停止 Claude Code。'),
        entry('user', '新任务：总结结果'),
        entry('assistant', '新任务最终答复')
      ],
      history: [
        { role: 'user', content: '原始任务：检查项目' },
        { role: 'user', content: '中途引导：先看配置' },
        { role: 'assistant', content: '最终答复：配置正常' },
        { role: 'user', content: '失败请求：读取不存在的文件' },
        { role: 'user', content: '已停止请求：运行很久的任务' },
        { role: 'user', content: '新任务：总结结果' },
        { role: 'assistant', content: '新任务最终答复' }
      ]
    })
    const context = await snapshotSessionMentions(sessionMentionToken(source.title, source.id), target.id, id => store.getConversation(id))
    expect(context).toContain('原始任务：检查项目')
    expect(context).toContain('中途引导：先看配置')
    expect(context).toContain('最终答复：配置正常')
    expect(context).toContain('新任务：总结结果')
    expect(context).toContain('新任务最终答复')
    expect(context).not.toContain('失败请求：读取不存在的文件')
    expect(context).not.toContain('失败前的流式片段')
    expect(context).not.toContain('已停止请求：运行很久的任务')
    expect(context).not.toContain('上下文已压缩')
  })

  it('rejects a source whose visible user messages cannot be paired with model history', async () => {
    const source = await completed('历史损坏', '第一条问题', '第一条答复')
    const target = await store.createConversation('目标')
    const saved = (await store.getConversation(source.id))!
    await store.updateConversation(source.id, {
      timeline: [
        ...saved.timeline,
        { id: randomUUID(), kind: 'user', time: new Date().toISOString(), text: '无法配对的用户消息' }
      ]
    })
    await expect(snapshotSessionMentions(sessionMentionToken(source.title, source.id), target.id, id => store.getConversation(id)))
      .rejects.toThrow('消息与模型历史无法对应')
  })
})
