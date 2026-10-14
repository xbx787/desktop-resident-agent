// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: []
}

function conversation(id: string): ConversationSummary {
  const now = new Date().toISOString()
  return {
    id, title: `会话 ${id}`, createdAt: now, updatedAt: now, archivedAt: null, pinnedAt: null,
    mode: 'claude_code', taskStatus: 'idle', messageCount: 1, preview: `来自 ${id} 的消息`
  }
}

function snapshot(): AppSnapshot {
  return {
    mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', modelReady: true, claudeCodeReady: true,
    conversationId: 'a', timelineRevision: 1,
    timeline: [{ id: 'notice', kind: 'system', text: '准备就绪', time: new Date().toISOString() }],
    conversationLibrary: {
      settings, activeConversationId: 'a', conversations: [conversation('a'), conversation('b')]
    },
    contextUsage: { status: 'unavailable' }
  }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('conversation library layout', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI
  let selectConversation: ReturnType<typeof vi.fn>
  let createConversation: ReturnType<typeof vi.fn>
  let originalWidth: PropertyDescriptor | undefined
  let resizeCallbacks: ResizeObserverCallback[]

  beforeEach(() => {
    resizeCallbacks = []
    originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const nativeRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('panel-workspace')) {
        return new DOMRect(0, 0, Math.min(534, window.innerWidth - 20) - 2, 400)
      }
      return nativeRect.call(this)
    })
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { resizeCallbacks.push(callback) }
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    selectConversation = vi.fn(async () => undefined)
    createConversation = vi.fn(async () => undefined)
    bridge = new Proxy({ selectConversation, createConversation } as Record<string, unknown>, {
      get(target, property: string) {
        if (property in target) return target[property]
        if (property.startsWith('on')) return () => () => {}
        if (property === 'getContextUsage') return async () => ({ status: 'unavailable' })
        if (property === 'readAvatar') return async () => null
        if (property === 'listClaudeWorkflows' || property === 'searchWorkspaceFiles') return async () => []
        return async () => undefined
      }
    }) as unknown as PetAPI
    ;(window as unknown as { pet: PetAPI }).pet = bridge
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
    else delete (window as unknown as { innerWidth?: number }).innerWidth
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function renderAtWidth(width: number): Promise<void> {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot()} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
    await act(async () => click(host.querySelector('.panel-expand-toggle')!))
    await act(async () => click(host.querySelector('.panel-library-toggle')!))
  }

  it('keeps the expanded library beside chat while switching or creating conversations', async () => {
    await renderAtWidth(554)
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(true)
    expect(host.querySelector('.panel-chat-body')?.firstElementChild?.classList.contains('panel-library-drawer')).toBe(true)
    expect(host.querySelector('.panel-library-group-heading')?.textContent).toBe('近 7 天')
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => click([...host.querySelectorAll('.panel-session-main')].find((row) => row.textContent?.includes('会话 b'))!))
    expect(selectConversation).toHaveBeenCalledWith('b')
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => host.querySelector('.panel-feed')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => click(host.querySelector('.panel-library-new')!))
    expect(createConversation).toHaveBeenCalledOnce()
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('uses an overlay on a narrow display and closes it when the user returns to chat', async () => {
    await renderAtWidth(500)
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(false)
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => host.querySelector('.panel-feed')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    await act(async () => click([...host.querySelectorAll('.panel-session-main')].find((row) => row.textContent?.includes('会话 b'))!))
    expect(selectConversation).toHaveBeenCalledWith('b')
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })

  it('falls back to the overlay if the available width shrinks while the library is open', async () => {
    await renderAtWidth(554)
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(true)

    await act(async () => {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
      for (const callback of resizeCallbacks) callback([], {} as ResizeObserver)
    })
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(false)
    expect(host.querySelector('.panel-library-drawer')).not.toBeNull()
    await act(async () => host.querySelector('.panel-feed')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded')).toBe('false')
  })
})
