import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { MemoryService, containsSensitiveData, type MemoryProvider } from '../src/main/memory-service'

const provider: MemoryProvider = {
  baseUrl: 'https://example.test/anthropic', apiKey: 'example-test-key',
  model: 'main-model', smallModel: 'small-model'
}

let root = ''
beforeEach(async () => {
  const cache = path.join(process.cwd(), '.cache')
  await fs.mkdir(cache, { recursive: true })
  root = await fs.mkdtemp(path.join(cache, 'memory-test-'))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

function fakeFetch(output: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ content: [{ type: 'text', text: output }] })
  })) as unknown as typeof fetch
}

function turn(userText: string, conversationId = 'conversation-1') {
  return { conversationId, userText, finalReply: '已完成。', success: true, provider }
}

describe('MemoryService', () => {
  it('extracts at most three facts with the small model, attributes the source, and persists atomically', async () => {
    const request = fakeFetch(JSON.stringify({ facts: ['喜欢中文回答。', '项目使用 TypeScript。', '偏好简短解释。', '不应保存第四条。'] }))
    const service = new MemoryService(root, { fetch: request })
    const added = await service.observeTurn(turn('我喜欢中文回答，项目使用 TypeScript，解释要简短。'))
    expect(added).toHaveLength(3)
    expect(added[0]).toMatchObject({ text: '喜欢中文回答。', sourceConversationId: 'conversation-1' })
    expect((request as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://example.test/anthropic/v1/messages')
    const requestBody = JSON.parse((request as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string)
    expect(requestBody.model).toBe('small-model')
    expect(requestBody.messages).toEqual([{ role: 'user', content: '我喜欢中文回答，项目使用 TypeScript，解释要简短。' }])
    const loaded = new MemoryService(root)
    expect(await loaded.list()).toHaveLength(3)
    expect(await fs.readdir(path.dirname(service.filePath))).toEqual(['facts.json'])
  })

  it('deduplicates normalized facts and ignores unsafe or malformed output', async () => {
    const responses = [
      '{"facts":["喜欢中文回答。","偏好详细解释。"]}',
      '```json\n{"facts":["喜欢中文回答","API Key 是 sk-1234567890123456","偏好详细解释。","喜欢用深色主题。"]}\n```',
      'not json'
    ]
    const request = vi.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: 'text', text: responses.shift() }] }) })) as unknown as typeof fetch
    const service = new MemoryService(root, { fetch: request })
    expect(await service.observeTurn(turn('以后请用中文回答。'))).toHaveLength(2)
    expect(await service.observeTurn(turn('深色主题也很好。'))).toHaveLength(1)
    expect(await service.observeTurn(turn('今天再聊聊。'))).toEqual([])
    expect((await service.list()).map((item) => item.text)).toContain('喜欢用深色主题。')
  })

  it('never extracts a failed turn or a user message with obvious secrets', async () => {
    const request = fakeFetch('{"facts":["应当保存"]}')
    const service = new MemoryService(root, { fetch: request })
    expect(await service.observeTurn({ ...turn('喜欢蓝色。'), success: false })).toEqual([])
    expect(await service.observeTurn(turn('我的 API key 是 sk-12345678901234567890，喜欢蓝色。'))).toEqual([])
    expect(await service.observeTurn(turn('联系我 example@example.com。'))).toEqual([])
    expect(request).not.toHaveBeenCalled()
    expect(await service.list()).toEqual([])
  })

  it('edits and deletes facts while preserving source and rejecting duplicate edits', async () => {
    const service = new MemoryService(root, { fetch: fakeFetch('{"facts":["喜欢中文回答。","喜欢深色主题。"]}') })
    const added = await service.observeTurn(turn('我喜欢中文回答，也喜欢深色主题。'))
    const updated = await service.update(added[0].id, '  更喜欢简洁的中文回答。  ')
    expect(updated.text).toBe('更喜欢简洁的中文回答。')
    expect(updated.sourceConversationId).toBe('conversation-1')
    await expect(service.update(added[1].id, updated.text)).rejects.toThrow('已经存在')
    await service.delete(added[0].id)
    expect((await service.list()).map((item) => item.id)).toEqual([added[1].id])
    await expect(service.update('missing', '足够长的事实。')).rejects.toThrow('找不到')
  })

  it('keeps extraction failure nonblocking and leaves corrupt data untouched', async () => {
    const onError = vi.fn()
    const request = vi.fn(async () => { throw new Error('secret in provider error') }) as unknown as typeof fetch
    const service = new MemoryService(root, { fetch: request, onError })
    expect(await service.observeTurn(turn('我喜欢中文回答。'))).toEqual([])
    expect(onError).toHaveBeenCalledOnce()
    expect(onError.mock.calls[0][0].message).not.toContain('secret')
    await service.initialize()
    const raw = '{invalid'
    await fs.writeFile(service.filePath, raw, 'utf8')
    await expect(new MemoryService(root).list()).rejects.toThrow('原文件已保留')
    expect(await fs.readFile(service.filePath, 'utf8')).toBe(raw)
  })

  it('builds a bounded next-turn context and honors the enable switch', async () => {
    const service = new MemoryService(root, { fetch: fakeFetch('{"facts":["喜欢中文回答。"]}') })
    await service.observeTurn(turn('请一直用中文回答。'))
    expect(await service.contextBlock()).toContain('喜欢中文回答。')
    service.setEnabled(false)
    expect(await service.contextBlock()).toBe('')
    expect(await service.observeTurn(turn('喜欢蓝色。'))).toEqual([])
    expect(await service.list()).toHaveLength(1)
  })

  it('serializes simultaneous turns so the same fact is stored only once', async () => {
    const service = new MemoryService(root, { fetch: fakeFetch('{"facts":["喜欢简洁的中文回答。"]}') })
    const [first, second] = await Promise.all([
      service.observeTurn(turn('请用简洁的中文回答。', 'conversation-1')),
      service.observeTurn(turn('请用简洁的中文回答。', 'conversation-2'))
    ])
    expect(first.length + second.length).toBe(1)
    expect(await service.list()).toHaveLength(1)
  })

  it('does not save an in-flight extraction after memory is disabled', async () => {
    let finish!: (value: Response) => void
    const request = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })) as unknown as typeof fetch
    const service = new MemoryService(root, { fetch: request })
    const pending = service.observeTurn(turn('喜欢简洁的中文回答。'))
    service.setEnabled(false)
    finish({ ok: true, json: async () => ({ content: [{ type: 'text', text: '{"facts":["喜欢简洁的中文回答。"]}' }] }) } as Response)
    expect(await pending).toEqual([])
    expect(await service.list()).toEqual([])
  })
})

describe('containsSensitiveData', () => {
  it('rejects representative credentials and private contacts', () => {
    expect(containsSensitiveData('Bearer sk-12345678901234567890')).toBe(true)
    expect(containsSensitiveData('密码：test')).toBe(true)
    expect(containsSensitiveData('邮箱地址：me@example.com')).toBe(true)
    expect(containsSensitiveData('习惯用中文写代码')).toBe(false)
  })
})
