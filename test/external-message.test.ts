import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationController } from '../src/main/conversation-controller'
import { ConversationStore } from '../src/main/conversation-store'
import { NoteStore } from '../src/main/note-store'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `external-message-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('external conversation messages', () => {
  it('adds a visible notice without starting a model turn', async () => {
    const store = new ConversationStore(testRoot)
    const controller = new ConversationController(store,
      (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
    await controller.initialize()
    const id = controller.displayedConversationId()!
    await controller.appendExternalMessage('全部改完。', { name: '开发二', badge: '开' })
    const saved = await store.getConversation(id)
    expect(saved?.timeline.at(-1)).toMatchObject({
      kind: 'user', text: '全部改完。', sender: { name: '开发二', badge: '开' }
    })
    expect(controller.displayedRuntime()!.getSnapshot().taskStatus).toBe('idle')
  })
})
