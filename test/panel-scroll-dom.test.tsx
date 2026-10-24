// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 0,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'dsh',
  taskStatus: 'idle', messageCount: 1, preview: ''
}

const snapshot: AppSnapshot = {
  mode: 'dsh', avatarState: 'idle', taskStatus: 'idle',
  timeline: [{ id: 'u1', kind: 'user', time: '2026-10-15T10:00:00.000Z', text: '你好' }],
  timelineRevision: 1, modelReady: true, dshReady: true, conversationId: 'a',
  approvalMode: 'workspace-write',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] }
}

describe('conversation switch scrolling', () => {
  let host: HTMLDivElement
  let root: Root
  let scrollTo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => undefined)
    scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { value: scrollTo, configurable: true })
    const bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (String(prop).startsWith('on')) return () => () => {}
        if (prop === 'getDraft') return () => Promise.resolve('')
        if (prop === 'getContextUsage') return () => Promise.resolve({ status: 'unavailable' })
        if (prop === 'readAvatar') return () => Promise.resolve(null)
        if (prop === 'listClaudeWorkflows') return () => Promise.resolve([])
        if (prop === 'searchWorkspaceFiles') return () => Promise.resolve([])
        return () => Promise.resolve(true)
      }
    }) as unknown as PetAPI
    ;(window as unknown as { pet: PetAPI }).pet = bridge
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    vi.unstubAllGlobals()
  })

  it('runs the back-to-bottom action again when the conversation changes', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    const feed = host.querySelector<HTMLElement>('.panel-feed')!
    Object.defineProperty(feed, 'scrollHeight', { value: 1200, configurable: true })
    Object.defineProperty(feed, 'clientHeight', { value: 400, configurable: true })
    feed.scrollTop = 0
    const switched: AppSnapshot = {
      ...snapshot,
      conversationId: 'b',
      timelineRevision: 2,
      conversationLibrary: { ...snapshot.conversationLibrary!, activeConversationId: 'b', conversations: [conversation] }
    }
    await act(async () => {
      root.render(<PanelBubble visible snapshot={switched} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    // 切换对话用直接赋值定位，不走平滑滚动，免得 onScroll 把跟随关掉。
    expect(feed.scrollTop).toBe(1200)
  })

  it('keeps pinning when the switched transcript arrives in a later snapshot', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    const feed = host.querySelector<HTMLElement>('.panel-feed')!
    Object.defineProperty(feed, 'clientHeight', { value: 400, configurable: true })
    Object.defineProperty(feed, 'scrollHeight', { value: 800, configurable: true })
    const switched: AppSnapshot = {
      ...snapshot,
      conversationId: 'b',
      timelineRevision: 2,
      conversationLibrary: { ...snapshot.conversationLibrary!, activeConversationId: 'b', conversations: [conversation] }
    }
    await act(async () => {
      root.render(<PanelBubble visible snapshot={switched} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    // 新对话的内容晚一拍才到：高度变大后仍要留在最底。
    Object.defineProperty(feed, 'scrollHeight', { value: 2400, configurable: true })
    const arrived: AppSnapshot = {
      ...switched,
      timelineRevision: 3,
      timeline: [...switched.timeline,
        { id: 'b1', kind: 'user', time: '2026-10-15T10:01:00.000Z', text: '第二条' },
        { id: 'b2', kind: 'assistant', time: '2026-10-15T10:01:10.000Z', text: '答复' }]
    }
    await act(async () => {
      root.render(<PanelBubble visible snapshot={arrived} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    expect(feed.scrollTop).toBe(2400)
  })
})
