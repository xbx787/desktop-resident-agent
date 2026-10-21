import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationController } from '../src/main/conversation-controller'
import { ConversationStore } from '../src/main/conversation-store'
import type { ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `steer-interrupt-${randomUUID()}`)

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

describe('插队发送（内核没有原生 steer 时）', () => {
  it('打断当前回合、把插队消息排在队首，并且不写人工中止提示', async () => {
    const prompts: string[] = []
    const replies: Array<(reply: ModelReply) => void> = []
    let interrupts = 0
    const model: ModelClient = {
      respond: (history) => {
        prompts.push([...history].reverse().find((line) => line.role === 'user')?.content ?? '')
        return new Promise<ModelReply>((resolve) => replies.push(resolve))
      },
      interrupt: async () => { interrupts += 1 }
    }
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (_conversationId, onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange, model))
    await controller.initialize()
    const id = controller.displayedConversationId()!

    await controller.sendMessage('先跑一轮')
    await until(() => controller.displayedRuntime()!.isRunning(), 'first turn')
    expect(prompts).toEqual(['先跑一轮'])

    await controller.sendMessage('插队这一条', [], 'steer')
    // 没有原生 steer 时不再打断：消息留在队列，当前回合结束后再发。
    expect(interrupts).toBe(0)
    expect(controller.getSnapshot().pendingMessages?.map((message) => message.text)).toEqual(['插队这一条'])

    replies[0]({ text: '第一轮答复' })
    await until(() => prompts.length === 2, 'steered turn')
    expect(prompts[1]).toBe('插队这一条')
    expect(controller.getSnapshot().timeline.some((entry) => entry.text.includes('已由人工中止'))).toBe(false)

    replies[1]({ text: '插队答复' })
    await controller.flushAll()
    const saved = await store.getConversation(id)
    expect(saved?.timeline.some((entry) => entry.kind === 'assistant' && entry.text === '插队答复')).toBe(true)
    expect(saved?.timeline.some((entry) => entry.kind === 'system' && entry.text.includes('已由人工中止'))).toBe(false)
  })
})
