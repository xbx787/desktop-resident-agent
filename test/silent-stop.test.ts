import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationController } from '../src/main/conversation-controller'
import { ConversationStore } from '../src/main/conversation-store'
import type { ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `silent-stop-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('silent stop on app quit', () => {
  it('keeps the transcript but writes no "已停止思考" notice', async () => {
    let finish!: (reply: ModelReply) => void
    const model: ModelClient = {
      respond: (_history, _signal, _progress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'tool-1', toolName: 'Bash', phase: 'start' })
        return new Promise((resolve) => { finish = resolve })
      }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.displayedConversationId()!

    await controller.sendMessage('运行中退出')
    await until(() => controller.displayedRuntime()!.isRunning(), 'running turn')
    controller.stopAll(true)
    await controller.flushAll()

    const saved = await store.getConversation(id)
    expect(saved?.timeline.some((entry) => entry.kind === 'system' && entry.text.includes('已停止思考'))).toBe(false)
    expect(saved?.timeline.some((entry) => entry.kind === 'tool')).toBe(false)
    expect(saved?.timeline.some((entry) => entry.kind === 'user' && entry.text === '运行中退出')).toBe(true)

    finish({ text: '答复' })
  })
})
