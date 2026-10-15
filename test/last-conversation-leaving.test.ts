import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import { ConversationController } from '../src/main/conversation-controller'
import { ConversationStore } from '../src/main/conversation-store'
import { NoteStore } from '../src/main/note-store'

/** The last tab leaving the strip has to reach the renderer as an empty one.
 *  Archiving or deleting it used to emit the pre-change library instead: the
 *  tab stayed on screen while the transcript went blank, and the panel looked
 *  stuck on that stale copy until some other action refreshed the library. */

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.join(projectRoot, '.cache', 'tests', `last-tab-${randomUUID()}`)
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

function controllerFor(store: ConversationStore): ConversationController {
  return new ConversationController(store,
    (onChange) => new AgentRuntime(new NoteStore(testRoot), undefined, onChange))
}

describe('the last conversation leaving the tab strip', () => {
  it('publishes the empty library when the only conversation is archived', async () => {
    const store = new ConversationStore(testRoot)
    const only = await store.createConversation('唯一会话', 'claude_code')
    const controller = controllerFor(store)
    await controller.initialize()
    await controller.selectConversation(only.id)

    const state = await controller.archiveConversation(only.id)
    // The IPC answer and the published snapshot are the same library, and both
    // must describe the archive — the renderer draws the tab strip from it.
    expect(state.activeConversationId).toBeNull()
    expect(state.conversations.find((item) => item.id === only.id)?.archivedAt).not.toBeNull()
    const snapshot = controller.getSnapshot()
    expect(snapshot.conversationLibrary.activeConversationId).toBeNull()
    expect(snapshot.conversationLibrary.conversations.filter((item) => item.archivedAt === null)).toHaveLength(0)
    expect(snapshot.timeline).toHaveLength(0)

    // The "+" on the empty panel still opens a session.
    const fresh = await controller.createConversation()
    expect(controller.getSnapshot().conversationLibrary.activeConversationId).toBe(fresh.id)
    expect(controller.getSnapshot().conversationLibrary.conversations.filter((item) => item.archivedAt === null)).toHaveLength(1)
  })

  it('publishes the empty library when the only conversation is deleted', async () => {
    const store = new ConversationStore(testRoot)
    const only = await store.createConversation('唯一会话', 'claude_code')
    const controller = controllerFor(store)
    await controller.initialize()
    await controller.selectConversation(only.id)

    const state = await controller.deleteConversation(only.id)
    expect(state.activeConversationId).toBeNull()
    expect(state.conversations.find((item) => item.id === only.id)).toBeUndefined()
    const snapshot = controller.getSnapshot()
    expect(snapshot.conversationLibrary.activeConversationId).toBeNull()
    expect(snapshot.conversationLibrary.conversations).toHaveLength(0)
  })

  it('hands the panel to the survivor when the displayed conversation is archived', async () => {
    const store = new ConversationStore(testRoot)
    const first = await store.createConversation('先建的会话', 'claude_code')
    const controller = controllerFor(store)
    await controller.initialize()
    const shown = await controller.createConversation('第二个会话')
    expect(controller.getSnapshot().conversationId).toBe(shown.id)

    const state = await controller.archiveConversation(shown.id)
    expect(state.activeConversationId).toBe(first.id)
    expect(state.conversations.find((item) => item.id === shown.id)?.archivedAt).not.toBeNull()
    expect(controller.getSnapshot().conversationId).toBe(first.id)
  })

  it('leaves the displayed conversation alone when a background tab is archived', async () => {
    const store = new ConversationStore(testRoot)
    const background = await store.createConversation('后台会话', 'claude_code')
    const controller = controllerFor(store)
    await controller.initialize()
    const shown = await controller.createConversation('显示中的会话')

    const state = await controller.archiveConversation(background.id)
    expect(state.activeConversationId).toBe(shown.id)
    expect(state.conversations.find((item) => item.id === background.id)?.archivedAt).not.toBeNull()
    expect(controller.getSnapshot().conversationId).toBe(shown.id)
  })
})
