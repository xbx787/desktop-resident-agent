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
    id, title: `会话 ${id}`, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
    archivedAt: archived ? '2026-10-13T01:00:00.000Z' : null, pinnedAt: null, mode: 'claude_code',
    taskStatus: 'idle', messageCount: 1, preview: ''
  }
}

function snapshot(): AppSnapshot {
  return {
    mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', modelReady: true, claudeCodeReady: true,
    conversationId: 'a', timelineRevision: 1,
    timeline: [{ id: 'notice', kind: 'system', text: '准备就绪', time: '2026-10-13T00:00:00.000Z' }],
    conversationLibrary: {
      settings, activeConversationId: 'a', conversations: [summary('a'), summary('b'), summary('old', true)]
    },
    contextUsage: { status: 'unavailable' }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function passDebounce(): Promise<void> {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)) })
}

describe('conversation library search', () => {
  let host: HTMLDivElement
  let root: Root
  let searchConversations: ReturnType<typeof vi.fn>
  let bridge: PetAPI

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    searchConversations = vi.fn()
    bridge = new Proxy({ searchConversations } as Record<string, unknown>, {
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

  async function openLibrary(): Promise<HTMLInputElement> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot()} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
    await act(async () => click(host.querySelector('.panel-library-toggle')!))
    await act(async () => click(host.querySelector('.panel-session-menu-all')!))
    return host.querySelector<HTMLInputElement>('.panel-library-search')!
  }

  function listText(): string {
    return host.querySelector('.panel-session-list')?.textContent ?? ''
  }

  it('waits through the debounce and pending request without showing a false empty result', async () => {
    const pending = deferred<ConversationSummary[]>()
    searchConversations.mockReturnValue(pending.promise)
    const input = await openLibrary()
    await act(async () => type(input, '鲸'))
    expect(listText()).toContain('正在搜索')
    expect(listText()).not.toContain('没有找到会话')
    expect(searchConversations).not.toHaveBeenCalled()

    await passDebounce()
    expect(searchConversations).toHaveBeenCalledExactlyOnceWith('鲸', false)
    expect(listText()).toContain('正在搜索')
    expect(listText()).not.toContain('没有找到会话')

    await act(async () => pending.resolve([summary('b')]))
    expect(listText()).toContain('会话 b')
    expect(listText()).not.toContain('正在搜索')
  })

  it('distinguishes a confirmed empty result from a failed search', async () => {
    const first = deferred<ConversationSummary[]>()
    const second = deferred<ConversationSummary[]>()
    searchConversations.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const input = await openLibrary()
    await act(async () => type(input, '空'))
    await passDebounce()
    await act(async () => first.resolve([]))
    expect(listText()).toContain('没有找到会话')
    expect(listText()).not.toContain('搜索失败')

    await act(async () => type(input, '失败'))
    expect(listText()).toContain('正在搜索')
    expect(listText()).not.toContain('没有找到会话')
    await passDebounce()
    await act(async () => second.reject(new Error('offline')))
    expect(listText()).toContain('搜索失败')
    expect(listText()).not.toContain('没有找到会话')
  })

  it('keeps the newer query result when the older request finishes last', async () => {
    const first = deferred<ConversationSummary[]>()
    const second = deferred<ConversationSummary[]>()
    searchConversations.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const input = await openLibrary()
    await act(async () => type(input, '旧'))
    await passDebounce()
    await act(async () => type(input, '新'))
    expect(listText()).toContain('正在搜索')
    await passDebounce()
    expect(searchConversations).toHaveBeenNthCalledWith(2, '新', false)

    await act(async () => second.resolve([summary('new')]))
    expect(listText()).toContain('会话 new')
    await act(async () => first.resolve([summary('stale')]))
    expect(listText()).toContain('会话 new')
    expect(listText()).not.toContain('会话 stale')
  })

  it('rechecks message content after a conversation summary changes and ignores the old search', async () => {
    const oldSearch = deferred<ConversationSummary[]>()
    const newSearch = deferred<ConversationSummary[]>()
    searchConversations.mockReturnValueOnce(oldSearch.promise).mockReturnValueOnce(newSearch.promise)
    const input = await openLibrary()
    await act(async () => type(input, '新增内容'))
    await passDebounce()
    expect(searchConversations).toHaveBeenCalledTimes(1)

    const updated = snapshot()
    updated.conversationLibrary!.conversations[0] = {
      ...updated.conversationLibrary!.conversations[0],
      updatedAt: '2026-10-13T02:00:00.000Z', messageCount: 2, preview: '新增内容'
    }
    await act(async () => root.render(<PanelBubble visible snapshot={updated} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
    expect(listText()).toContain('正在搜索')
    await passDebounce()
    expect(searchConversations).toHaveBeenNthCalledWith(2, '新增内容', false)

    await act(async () => newSearch.resolve([updated.conversationLibrary!.conversations[0]]))
    expect(listText()).toContain('新增内容')
    await act(async () => oldSearch.resolve([]))
    expect(listText()).toContain('新增内容')
    expect(listText()).not.toContain('没有找到会话')
  })

  it('treats the archive tab as a new search scope and ignores its previous result', async () => {
    const unarchived = deferred<ConversationSummary[]>()
    const archived = deferred<ConversationSummary[]>()
    searchConversations.mockReturnValueOnce(unarchived.promise).mockReturnValueOnce(archived.promise)
    const input = await openLibrary()
    await act(async () => type(input, '项目'))
    await passDebounce()
    await act(async () => click([...host.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === '已归档')!))
    expect(listText()).toContain('正在搜索')
    expect(listText()).not.toContain('没有找到会话')
    await passDebounce()
    expect(searchConversations).toHaveBeenNthCalledWith(2, '项目', true)

    await act(async () => archived.resolve([summary('archive', true)]))
    expect(host.querySelector('.panel-session-list')?.getAttribute('aria-label')).toBe('已归档会话')
    expect(listText()).toContain('会话 archive')
    await act(async () => unarchived.resolve([summary('live')]))
    expect(listText()).toContain('会话 archive')
    expect(listText()).not.toContain('会话 live')
  })
})
