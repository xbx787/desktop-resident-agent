import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InboxWatcher, parseInboxMessage } from '../src/main/inbox-watcher'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `inbox-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('inbox watcher', () => {
  it('derives the sender from the conversation prefix in the body', () => {
    expect(parseInboxMessage({ text: '【来自对话「开发二」】\n全部改完。' })).toEqual({
      from: { name: '开发二', badge: '开' },
      text: '【来自对话「开发二」】\n全部改完。'
    })
    expect(parseInboxMessage({ from: { name: '开发二', badge: '开' }, text: '你好' })).toMatchObject({
      from: { name: '开发二', badge: '开' }
    })
    expect(parseInboxMessage({ text: '没有来源' })).toBeNull()
    expect(parseInboxMessage({ text: '全部改完。', sourceConversationId: 'dev2' })).toEqual({
      text: '全部改完。', sourceConversationId: 'dev2'
    })
  })

  it('delivers one file to the controller and removes it', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, '001.json'), JSON.stringify({
      text: '【来自对话「开发二」】\n全部改完。'
    }))
    const appendExternalMessage = vi.fn(async () => undefined)
    const watcher = new InboxWatcher(testRoot, {
      appendExternalMessage,
      conversationSender: () => undefined
    } as never, 50)
    await watcher.poll()
    expect(appendExternalMessage).toHaveBeenCalledWith(
      '【来自对话「开发二」】\n全部改完。',
      { name: '开发二', badge: '开' },
      undefined
    )
    expect(await fs.readdir(testRoot)).toEqual([])
  })

  it('keeps an invalid file as .failed instead of retrying forever', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, 'bad.json'), '{not json')
    const watcher = new InboxWatcher(testRoot, {
      appendExternalMessage: vi.fn(),
      conversationSender: () => undefined
    } as never, 50)
    await watcher.poll()
    expect(await fs.readdir(testRoot)).toEqual(['bad.json.failed'])
  })

  it('starts a model turn for an explicit autoRun message', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, '003.json'), JSON.stringify({
      from: { name: '定时任务', badge: '时' },
      text: '执行今天的任务',
      autoRun: true
    }))
    const appendExternalMessage = vi.fn(async () => undefined)
    const sendMessage = vi.fn(async () => ({ id: 'queued' }))
    const watcher = new InboxWatcher(testRoot, {
      appendExternalMessage,
      sendMessage,
      conversationSender: () => undefined
    } as never, 50)
    expect(parseInboxMessage({ from: { name: '定时任务', badge: '时' }, text: '执行', autoRun: true }))
      .toMatchObject({ autoRun: true })
    await watcher.poll()
    expect(sendMessage).toHaveBeenCalledWith('执行今天的任务', [], 'queue', undefined)
    expect(appendExternalMessage).not.toHaveBeenCalled()
    expect(await fs.readdir(testRoot)).toEqual([])
  })

  it('uses the source conversation title as the sender', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, '002.json'), JSON.stringify({
      text: '全部改完。', sourceConversationId: 'dev2'
    }))
    const appendExternalMessage = vi.fn(async () => undefined)
    const watcher = new InboxWatcher(testRoot, {
      appendExternalMessage,
      conversationSender: (id: string) => id === 'dev2' ? { name: '开发2', badge: '开' } : undefined
    } as never, 50)
    await watcher.poll()
    expect(appendExternalMessage).toHaveBeenCalledWith(
      '全部改完。', { name: '开发2', badge: '开' }, undefined
    )
  })
})
