// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** After a restart the composer comes back empty from a cold start — the text
 *  the owner had half-written has to be pulled from the conversation record
 *  instead of being typed again. */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: []
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'claude_code',
  taskStatus: 'idle', messageCount: 0, preview: ''
}

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle',
  timeline: [], timelineRevision: 0, modelReady: true, claudeCodeReady: true,
  conversationId: 'a',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] }
}

describe('the composer draft after a restart', () => {
  let host: HTMLDivElement
  let root: Root
  const saved = '写到一半的一句话'
  let bridge: PetAPI

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (String(prop).startsWith('on')) return () => () => {}
        if (prop === 'getDraft') return vi.fn(async () => saved)
        if (prop === 'getContextUsage') return () => Promise.resolve({ status: 'unavailable' })
        if (prop === 'readAvatar') return () => Promise.resolve(null)
        if (prop === 'listClaudeWorkflows') return () => Promise.resolve([])
        if (prop === 'searchWorkspaceFiles') return () => Promise.resolve([])
        return () => Promise.resolve(undefined)
      }
    }) as unknown as PetAPI
    (window as unknown as { pet: PetAPI }).pet = bridge
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
  })

  it('pulls the saved draft back into the textarea', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(bridge); return true }} />)
    })
    // The restore lands through a promise; let it settle before reading the DOM.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')
    expect(textarea).toBeTruthy()
    expect(textarea!.value).toBe(saved)
  })
})
