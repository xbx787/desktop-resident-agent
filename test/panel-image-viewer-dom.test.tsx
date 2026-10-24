// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI, TimelineEntry } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'
import { eventImageCache } from '../src/renderer/event-images'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A sent message's picture must open the viewer, not just show a zoom cursor.
 *  回归：turn 开场的用户消息曾漏传 onOpenImage，点击落在空函数上。 */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'dsh',
  taskStatus: 'idle', messageCount: 2, preview: ''
}

const at = (seconds: number): string => new Date(Date.parse('2026-10-15T10:00:00.000Z') + seconds * 1000).toISOString()

const timeline: TimelineEntry[] = [
  { id: 'u1', kind: 'user', time: at(0), text: '看看这张图\n附件：shot.png', images: [{ name: 'shot.png', path: 'D:/tmp/shot.png' }] },
  { id: 'a1', kind: 'assistant', time: at(5), text: '看到了。' }
]

const snapshot: AppSnapshot = {
  mode: 'dsh', avatarState: 'idle', taskStatus: 'idle',
  timeline, timelineRevision: 1, modelReady: true, dshReady: true,
  conversationId: 'a',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] }
}

describe('a sent picture opens the image viewer', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    eventImageCache.clear()
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    const bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (String(prop).startsWith('on')) return () => () => {}
        if (prop === 'getDraft') return () => Promise.resolve('')
        if (prop === 'getContextUsage') return () => Promise.resolve({ status: 'unavailable' })
        if (prop === 'readAvatar') return () => Promise.resolve(null)
        if (prop === 'readImagePreview') return () => Promise.resolve('data:image/png;base64,AAAA')
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

  it('opens the viewer when the thumbnail in a user message is clicked', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    // 缩略图经由 readImagePreview 异步解析，等一拍让按钮出现。
    await act(async () => { await Promise.resolve() })
    const thumb = host.querySelector<HTMLButtonElement>('.panel-event-image')
    expect(thumb).toBeTruthy()
    expect(thumb!.getAttribute('aria-label')).toBe('查看图片 shot.png')
    await act(async () => { thumb!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const viewer = host.querySelector('.panel-image-viewer')
    expect(viewer).toBeTruthy()
    expect(viewer!.getAttribute('aria-label')).toBe('关闭图片预览：shot.png')
  })
})
