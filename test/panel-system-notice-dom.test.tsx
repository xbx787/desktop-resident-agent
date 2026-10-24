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
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z',
  lastActivityAt: '2026-10-13T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'dsh',
  taskStatus: 'idle', messageCount: 3, preview: ''
}

function snapshot(): AppSnapshot {
  return {
    mode: 'dsh', avatarState: 'idle', taskStatus: 'idle', modelReady: true, dshReady: true,
    conversationId: 'a', timelineRevision: 1,
    timeline: [
      { id: 'user-1', kind: 'user', text: '开始', time: '2026-10-13T00:00:00.000Z' },
      { id: 'assistant-1', kind: 'assistant', text: '原来的回答', time: '2026-10-13T00:01:00.000Z' },
      { id: 'compact-1', kind: 'system', text: '上下文已压缩，可以继续当前对话。', time: '2026-10-13T00:02:00.000Z' },
      { id: 'error-1', kind: 'system', text: '模型请求失败。', tone: 'error', time: '2026-10-13T00:03:00.000Z' }
    ],
    conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] },
    contextUsage: { status: 'unavailable' }
  }
}

describe('system notices keep their own row', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    const bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, property: string) {
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

  it('leaves the answer intact and renders notices outside the turn', async () => {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot()} error={null}
      run={async (action) => { try { await action((window as unknown as { pet: PetAPI }).pet); return true } catch { return false } }} />))

    const turn = host.querySelector('.panel-turn')!
    expect(turn.textContent).toContain('原来的回答')
    expect(turn.querySelector('.panel-event-system')).toBeNull()

    const notices = [...host.querySelectorAll('.panel-event-system')]
    expect(notices.map((node) => node.textContent)).toEqual([
      '上下文已压缩，可以继续当前对话。',
      '!模型请求失败。'
    ])

    const failed = notices[1]
    expect(failed.classList.contains('is-error')).toBe(true)
    expect(failed.querySelector('.panel-event-system-mark')?.textContent).toBe('!')
    expect(notices[0].classList.contains('is-error')).toBe(false)
  })
})
