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

function summary(id: string, archived = false): ConversationSummary {
  return {
    id, title: `会话 ${id}`, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', lastActivityAt: '2026-10-13T00:00:00.000Z',
    archivedAt: archived ? '2026-10-13T01:00:00.000Z' : null, pinnedAt: null,
    mode: 'claude_code', taskStatus: 'idle', messageCount: 1, preview: `来自 ${id} 的消息`
  }
}

function snapshot(): AppSnapshot {
  return {
    mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', modelReady: true, claudeCodeReady: true,
    conversationId: 'a', timelineRevision: 1,
    timeline: [{ id: 'notice', kind: 'system', text: '准备就绪', time: '2026-10-13T00:00:00.000Z' }],
    conversationLibrary: {
      settings, activeConversationId: 'a',
      conversations: [summary('a'), summary('b'), summary('c'), summary('old', true)]
    },
    contextUsage: { status: 'unavailable' }
  }
}

function click(element: Element, options: MouseEventInit = {}): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, ...options }))
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('conversation library batch interactions', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI
  let selectConversation: ReturnType<typeof vi.fn>
  let batchManageConversations: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    selectConversation = vi.fn(async () => undefined)
    batchManageConversations = vi.fn(async (action: string, ids: string[]) => ({
      action, outcomes: ids.map((id) => ({ id, status: 'updated' as const }))
    }))
    bridge = new Proxy({ selectConversation, batchManageConversations } as Record<string, unknown>, {
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
    vi.unstubAllGlobals()
  })

  function row(id: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.panel-session-main')]
      .find((item) => item.textContent?.includes(`会话 ${id}`))
    if (!found) throw new Error(`Missing conversation ${id}`)
    return found
  }

  function button(label: string): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (!found) throw new Error(`Missing button ${label}`)
    return found
  }

  function selectedCount(): string {
    return host.querySelector('.panel-library-batch-count')?.textContent ?? ''
  }

  async function openLibrary(): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot()} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    await act(async () => click(host.querySelector('.panel-session-menu-all')!))
  }

  it('keeps ordinary row clicks opening a conversation', async () => {
    await openLibrary()
    await act(async () => click(row('b')))
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('b')
    expect(batchManageConversations).not.toHaveBeenCalled()
  })

  it('selects instead of opening in multi-select mode and by Alt+click', async () => {
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    expect(row('b').getAttribute('aria-pressed')).toBe('true')
    expect(selectedCount()).toBe('已选 1')
    expect(selectConversation).not.toHaveBeenCalled()

    await act(async () => click(row('c'), { altKey: true }))
    expect(row('c').getAttribute('aria-pressed')).toBe('true')
    expect(selectedCount()).toBe('已选 2')
    expect(selectConversation).not.toHaveBeenCalled()

    await act(async () => click(button('退出多选')))
    await act(async () => click(row('b'), { altKey: true }))
    expect(selectedCount()).toBe('已选 1')
    expect(selectConversation).not.toHaveBeenCalled()
  })

  it('clears the selection when archive scope or search query changes', async () => {
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    expect(selectedCount()).toBe('已选 1')

    await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === '已归档')!))
    expect(selectedCount()).toBe('已选 0')
    await act(async () => click(row('old')))
    expect(selectedCount()).toBe('已选 1')

    const search = host.querySelector<HTMLInputElement>('.panel-library-search')!
    await act(async () => type(search, '鲸'))
    expect(selectedCount()).toBe('已选 0')
    expect(batchManageConversations).not.toHaveBeenCalled()
  })

  it('requires one explicit confirmation before permanently deleting the selected sessions', async () => {
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    await act(async () => click(row('c')))
    await act(async () => click(button('删除已选会话')))
    expect(host.querySelector('.panel-library-batch-confirm')?.textContent).toBe('永久删除 2 个会话？')
    expect(batchManageConversations).not.toHaveBeenCalled()

    await act(async () => click([...host.querySelectorAll<HTMLButtonElement>('.panel-library-batch button')]
      .find((item) => item.textContent === '取消')!))
    expect(batchManageConversations).not.toHaveBeenCalled()

    await act(async () => click(button('删除已选会话')))
    await act(async () => click([...host.querySelectorAll<HTMLButtonElement>('.panel-library-batch button')]
      .find((item) => item.textContent === '删除')!))
    expect(batchManageConversations).toHaveBeenCalledExactlyOnceWith('delete', ['b', 'c'])
  })

  it('keeps skipped sessions selected and reports the partial result', async () => {
    batchManageConversations.mockResolvedValueOnce({
      action: 'archive', outcomes: [
        { id: 'b', status: 'updated' },
        { id: 'c', status: 'skipped', reason: 'busy' }
      ]
    })
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    await act(async () => click(row('c')))
    await act(async () => click(button('归档已选会话')))
    expect(batchManageConversations).toHaveBeenCalledExactlyOnceWith('archive', ['b', 'c'])
    expect(host.querySelector('.panel-library-error')?.textContent).toContain('已处理 1 个，跳过 1 个')
    expect(host.querySelector('.panel-library-error')?.textContent).toContain('会话仍在运行')
    expect(selectedCount()).toBe('已选 1')
    expect(row('c').getAttribute('aria-pressed')).toBe('true')
  })

  it('pins selected active sessions, then unpins them when all are pinned', async () => {
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    await act(async () => click(row('c')))
    expect(button('置顶已选会话').disabled).toBe(false)
    await act(async () => click(button('置顶已选会话')))
    expect(batchManageConversations).toHaveBeenNthCalledWith(1, 'pin', ['b', 'c'])
    expect(host.querySelector('.panel-library-batch')).toBeNull()

    const pinned = snapshot()
    for (const item of pinned.conversationLibrary!.conversations) {
      if (item.id === 'b' || item.id === 'c') item.pinnedAt = '2026-10-13T02:00:00.000Z'
    }
    await act(async () => root.render(<PanelBubble visible snapshot={pinned} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    await act(async () => click(row('c')))
    expect(button('取消置顶已选会话').disabled).toBe(false)
    await act(async () => click(button('取消置顶已选会话')))
    expect(batchManageConversations).toHaveBeenNthCalledWith(2, 'unpin', ['b', 'c'])
    expect(batchManageConversations).toHaveBeenCalledTimes(2)
  })

  it('exits multi-select with Escape and restores ordinary row clicks', async () => {
    await openLibrary()
    await act(async () => click(button('多选会话')))
    await act(async () => click(row('b')))
    expect(selectedCount()).toBe('已选 1')

    await act(async () => row('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('.panel-library-drawer:not(.is-closing)')).not.toBeNull()
    expect(host.querySelector('.panel-library-batch')).toBeNull()
    expect(button('多选会话').getAttribute('aria-pressed')).toBe('false')

    await act(async () => click(row('b')))
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('b')
  })
})
