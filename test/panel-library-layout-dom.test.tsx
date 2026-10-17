// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The library is always a floating pane over the conversation — it never
 *  squeezes the chat beside itself. The wide shape only earns the date
 *  headings in the list; closing behaviour is the same in both shapes. */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

function conversation(id: string): ConversationSummary {
  const now = new Date().toISOString()
  return {
    id, title: `会话 ${id}`, createdAt: now, updatedAt: now, lastActivityAt: now, archivedAt: null, pinnedAt: null,
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
  let originalWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const nativeRect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('panel-workspace')) {
        return new DOMRect(0, 0, Math.min(534, window.innerWidth - 20) - 2, 400)
      }
      return nativeRect.call(this)
    })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    selectConversation = vi.fn(async () => undefined)
    bridge = new Proxy({ selectConversation } as Record<string, unknown>, {
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

  const expanded = (): string | null => host.querySelector('.panel-library-toggle')?.getAttribute('aria-expanded') ?? null

  it('floats over the expanded chat, keeps the date headings, and folds away when a conversation is picked', async () => {
    await renderAtWidth(554)
    // A floating pane, not a column: no docked marker, and the drawer is its own box.
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(false)
    expect(host.querySelector('.panel-library-drawer')).not.toBeNull()
    // The wide shape still earns the list's date headings.
    expect(host.querySelector('.panel-library-group-heading')?.textContent).toBe('近 7 天')
    expect(expanded()).toBe('true')

    await act(async () => click([...host.querySelectorAll('.panel-session-main')].find((row) => row.textContent?.includes('会话 b'))!))
    expect(selectConversation).toHaveBeenCalledWith('b')
    expect(expanded()).toBe('false')
  })

  it('closes when the user goes back to the conversation', async () => {
    await renderAtWidth(554)
    await act(async () => host.querySelector('.panel-feed')?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })))
    expect(expanded()).toBe('false')
  })

  it("keeps a row's mode and dates in the row, shown on hover", async () => {
    await renderAtWidth(554)
    const meta = host.querySelector('.panel-session-meta')
    expect(meta).not.toBeNull()
    expect(meta?.textContent).toContain('Claude Code + DeepSeek')
    expect(meta?.textContent).toContain('创建')
    expect(meta?.textContent).toContain('活动')
    expect(meta?.textContent).toContain('条消息')
  })

  it('is the same floating pane on a narrow display, without the date headings', async () => {
    await renderAtWidth(500)
    expect(host.querySelector('.panel-bubble')?.classList.contains('is-library-docked')).toBe(false)
    expect(host.querySelector('.panel-library-drawer')).not.toBeNull()
    expect(host.querySelector('.panel-library-group-heading')).toBeNull()
    expect(expanded()).toBe('true')

    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    expect(expanded()).toBe('false')
  })
})
