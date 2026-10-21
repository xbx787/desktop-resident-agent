import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import type { ModelClient, ModelImage } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'
import type { UserAttachment } from '../src/shared/contracts'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `prompt-images-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

describe('图片随消息发给模型', () => {
  it('把图片读成 base64 传给内核，路径仍留在文本里', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    const imagePath = path.join(testRoot, 'shot.png')
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    let seen: ModelImage[] | undefined
    let prompt = ''
    const model: ModelClient = {
      respond: async (history, _signal, _progress, _session, _tool, _usage, _thinking, images) => {
        seen = images
        prompt = history.at(-1)?.content ?? ''
        return { text: '看到了' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const attachment: UserAttachment = { name: 'shot.png', content: '', path: imagePath }
    await runtime.sendMessage('看一下这张图', [attachment])

    expect(seen).toHaveLength(1)
    expect(seen![0].mimeType).toBe('image/png')
    expect(seen![0].data).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64'))
    expect(prompt).toContain('[用户附件：shot.png]')
  })

  it('普通附件不会被当成图片', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    const textPath = path.join(testRoot, 'note.txt')
    await fs.writeFile(textPath, 'hello', 'utf8')
    let seen: ModelImage[] | undefined = [{ name: 'x', mimeType: 'x', data: 'x' }]
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, _tool, _usage, _thinking, images) => {
        seen = images
        return { text: '好' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('读一下', [{ name: 'note.txt', content: 'hello', path: textPath }])
    expect(seen).toEqual([])
  })
})
