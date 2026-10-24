// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
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

describe('附件选择入口', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
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
        if (prop === 'listClaudeWorkflows') return () => Promise.resolve([])
        if (prop === 'searchWorkspaceFiles') return () => Promise.resolve([])
        return () => Promise.resolve(true)
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

  it('输入框工具栏有附件按钮，点它打开多选文件选择', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    await act(async () => { host.querySelector<HTMLElement>('.panel-compose-trigger')!.click() })
    const button = host.querySelector<HTMLButtonElement>('.panel-attachment-button')
    const input = host.querySelector<HTMLInputElement>('.panel-attachment-input')
    expect(button?.getAttribute('aria-label')).toBe('添加附件')
    expect(input?.type).toBe('file')
    expect(input?.multiple).toBe(true)
    const click = vi.spyOn(input!, 'click').mockImplementation(() => {})
    await act(async () => { button!.click() })
    expect(click).toHaveBeenCalledTimes(1)
  })
})
