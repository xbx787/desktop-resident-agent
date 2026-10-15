// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI, TaskStatus, TimelineEntry } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: []
}

const time = '2026-10-14T00:00:00.000Z'
const baseTimeline: TimelineEntry[] = [
  { id: 'user-old', kind: 'user', text: '旧问题', time },
  { id: 'answer-old', kind: 'assistant', text: '旧回答', time },
  { id: 'user-latest', kind: 'user', text: '新问题', time },
  { id: 'answer-progress', kind: 'assistant', text: '我先看一下。', time },
  { id: 'tool-read', kind: 'tool', text: 'Read', time,
    tool: { toolUseId: 'tool-1', name: 'Read', status: 'done', input: 'README.md', output: 'ok' } },
  { id: 'answer-final', kind: 'assistant', text: '最终回答', time }
]

function summary(id: string, status: TaskStatus = 'done'): ConversationSummary {
  return {
    id, title: `会话 ${id}`, createdAt: time, updatedAt: time, lastActivityAt: time, archivedAt: null, pinnedAt: null,
    mode: 'claude_code', taskStatus: status, messageCount: 2, preview: '最终回答'
  }
}

function snapshot(options: {
  activeId?: string
  status?: TaskStatus
  timeline?: TimelineEntry[]
  queued?: boolean
} = {}): AppSnapshot {
  const activeId = options.activeId ?? 'source'
  const status = options.status ?? 'done'
  return {
    mode: 'claude_code', avatarState: 'idle', taskStatus: status,
    modelReady: true, claudeCodeReady: true, conversationId: activeId,
    timelineRevision: 1, timeline: options.timeline ?? baseTimeline,
    conversationLibrary: {
      settings, activeConversationId: activeId,
      conversations: [summary('source', status), summary('child', 'idle')]
    },
    pendingMessages: options.queued ? [{ id: 'queued', text: '稍后再问', attachments: [], createdAt: time }] : [],
    contextUsage: { status: 'unavailable' }
  }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(editor: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, value)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function drop(host: HTMLElement, name: string): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['hello'], name)], types: ['Files'] } })
  host.querySelector('.panel-bubble')!.dispatchEvent(event)
}

describe('copy a conversation from its latest completed reply', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI
  let forkConversation: ReturnType<typeof vi.fn>
  let selectConversation: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    forkConversation = vi.fn(async () => 'child')
    selectConversation = vi.fn(async () => undefined)
    bridge = new Proxy({
      forkConversation, selectConversation,
      getPathForFile: (file: File) => `C:\\workspace\\${file.name}`,
      prepareDroppedFile: async (filePath: string) => ({ name: filePath.split('\\').at(-1)!, content: '', path: filePath })
    } as Record<string, unknown>, {
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

  async function render(value: AppSnapshot): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={value} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
  }

  async function openComposer(): Promise<HTMLTextAreaElement> {
    if (!host.querySelector('textarea[aria-label="输入消息"]')) {
      await act(async () => click(host.querySelector('.panel-compose-trigger')!))
    }
    return host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!
  }

  function forkButtons(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('button[aria-label="从最新回复复制会话续聊"]')]
  }

  it('shows one action on the newest finished answer and passes its final reply ID', async () => {
    await render(snapshot())
    const buttons = forkButtons()
    expect(buttons).toHaveLength(1)
    expect(buttons[0].closest('.panel-turn')?.querySelector('[data-entry-id="user-latest"]')).not.toBeNull()
    expect(buttons[0].title).toMatch(/不会回滚文件/)

    await act(async () => click(buttons[0]))
    expect(forkConversation).toHaveBeenCalledExactlyOnceWith('source', 'answer-final')
  })

  it.each(['planning', 'executing', 'failed', 'cancelled', 'idle'] as TaskStatus[])(
    'hides the action when the source status is %s', async (status) => {
      await render(snapshot({ status }))
      expect(forkButtons()).toHaveLength(0)
    }
  )

  it('hides the action while a queued message is pending or no complete reply exists', async () => {
    await render(snapshot({ queued: true }))
    expect(forkButtons()).toHaveLength(0)

    await render(snapshot({ timeline: baseTimeline.slice(0, -1) }))
    expect(forkButtons()).toHaveLength(0)

    await render(snapshot({ timeline: [...baseTimeline.slice(0, -1), { ...baseTimeline.at(-1)!, text: '   ' }] }))
    expect(forkButtons()).toHaveLength(0)
  })

  it('keeps the source draft and attachment, then opens an empty composer in the child', async () => {
    await render(snapshot())
    const editor = await openComposer()
    await act(async () => { type(editor, '来源草稿'); drop(host, 'notes.docx') })
    expect(host.querySelectorAll('.panel-attachment-chip')).toHaveLength(1)

    await act(async () => click(forkButtons()[0]))
    expect(forkConversation).toHaveBeenCalledExactlyOnceWith('source', 'answer-final')
    // The child is a copy of the source transcript, so its tab strip remains visible.
    await render(snapshot({ activeId: 'child', status: 'idle' }))
    const childEditor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')
    expect(childEditor).not.toBeNull()
    expect(childEditor?.value).toBe('')
    expect(host.querySelectorAll('.panel-attachment-chip')).toHaveLength(0)

    await act(async () => click(host.querySelector('[data-tab-id="source"]')!))
    expect(selectConversation).toHaveBeenCalledExactlyOnceWith('source')
    await render(snapshot())
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')?.value).toBe('来源草稿')
    expect([...host.querySelectorAll('.panel-attachment-chip')].map((chip) => chip.textContent)).toEqual(['DOCXnotes×'])
  })

  it('leaves the source draft and attachment in place when fork creation fails', async () => {
    forkConversation.mockRejectedValueOnce(new Error('源回复已变化'))
    await render(snapshot())
    const editor = await openComposer()
    await act(async () => { type(editor, '继续写'); drop(host, 'notes.docx') })

    await act(async () => click(forkButtons()[0]))
    expect(forkConversation).toHaveBeenCalledExactlyOnceWith('source', 'answer-final')
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')?.value).toBe('继续写')
    expect([...host.querySelectorAll('.panel-attachment-chip')].map((chip) => chip.textContent)).toEqual(['DOCXnotes×'])
  })
})
