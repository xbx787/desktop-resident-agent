// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Renaming a conversation: saving is a check (no word), and any click that
 *  lands outside the row gives up on it — same as pressing 取消. */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

function conversation(id: string, title: string): ConversationSummary {
  const now = new Date().toISOString()
  return {
    id, title, createdAt: now, updatedAt: now, lastActivityAt: now, archivedAt: null, pinnedAt: null,
    mode: 'dsh', taskStatus: 'idle', messageCount: 1, preview: '预览'
  }
}

function snapshot(): AppSnapshot {
  return {
    mode: 'dsh', avatarState: 'idle', taskStatus: 'idle', modelReady: true, dshReady: true,
    conversationId: 'a', timelineRevision: 1,
    timeline: [{ id: 'notice', kind: 'system', text: '准备就绪', time: new Date().toISOString() }],
    conversationLibrary: {
      settings, activeConversationId: 'a', conversations: [conversation('a', '第一条'), conversation('b', '第二条')]
    },
    contextUsage: { status: 'unavailable' }
  }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

/** React owns the input's value; a plain assignment is ignored, so set it the
 *  way the DOM setter would and let React hear about the change. */
function type(element: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('renaming a conversation from the library', () => {
  let host: HTMLDivElement
  let root: Root
  let renameConversation: ReturnType<typeof vi.fn>
  let originalWidth: PropertyDescriptor | undefined

  beforeEach(() => {
    originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 554 })
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    renameConversation = vi.fn(async () => undefined)
    const bridge = new Proxy({ renameConversation } as Record<string, unknown>, {
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
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  async function openRename(): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot()} error={null}
      run={async (action) => { await action((window as unknown as { pet: PetAPI }).pet); return true }} />))
    await act(async () => click(host.querySelector('.panel-expand-toggle')!))
    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    await act(async () => click(host.querySelector('[aria-label^="重命名"]')!))
  }

  it('saves from a check button instead of a word', async () => {
    await openRename()
    const save = host.querySelector('.panel-session-edit button[type="submit"]')!
    expect(save.getAttribute('aria-label')).toBe('保存名称')
    expect(save.textContent).toBe('')
    expect(save.querySelector('svg')).toBeTruthy()

    const input = host.querySelector('.panel-session-edit input') as HTMLInputElement
    await act(async () => type(input, '改过的名字'))
    await act(async () => click(save))
    expect(renameConversation).toHaveBeenCalledWith('a', '改过的名字')
  })

  it('gives up when the click lands outside the row', async () => {
    await openRename()
    expect(host.querySelector('.panel-session-edit')).not.toBeNull()
    await act(async () => host.querySelector('.panel-library-header h2')?.dispatchEvent(new Event('pointerdown', { bubbles: true })))
    expect(host.querySelector('.panel-session-edit')).toBeNull()
    expect(renameConversation).not.toHaveBeenCalled()
  })
})
