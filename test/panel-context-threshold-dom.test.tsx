// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI, TimelineEntry } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small',
  autoCompactPercent: 80
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'claude_code',
  taskStatus: 'idle', messageCount: 1, preview: ''
}

const timeline: TimelineEntry[] = [
  { id: 'u1', kind: 'user', time: '2026-10-15T10:00:00.000Z', text: '你好' }
]

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle',
  timeline, timelineRevision: 1, modelReady: true, claudeCodeReady: true,
  conversationId: 'a',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] },
  // The SDK's own estimate is deliberately wrong here; the menu must show the
  // configured value instead.
  contextUsage: {
    status: 'available', usedTokens: 550_000, maxTokens: 1_000_000, remainingTokens: 450_000,
    usedPercent: 55, remainingPercent: 45, autoCompactThresholdTokens: 970_000,
    autoCompactThresholdPercent: 97
  }
}

describe('the auto-compaction threshold row', () => {
  let host: HTMLDivElement
  let root: Root
  let calls: number[]

  beforeEach(() => {
    calls = []
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    const bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (String(prop).startsWith('on')) return () => () => {}
        if (prop === 'setAutoCompactPercent') return (percent: number) => { calls.push(percent); return Promise.resolve(undefined) }
        if (prop === 'getDraft') return () => Promise.resolve('')
        if (prop === 'getContextUsage') return () => Promise.resolve(snapshot.contextUsage)
        if (prop === 'readAvatar') return () => Promise.resolve(null)
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

  async function openMenu() {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.panel-expand-toggle')!.click()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.panel-compose-trigger')?.click()
    })
    await act(async () => {
      host.querySelector<HTMLButtonElement>('.panel-context-meter')!.click()
    })
    return host.querySelector<HTMLElement>('.panel-context-threshold')!
  }

  it('shows the configured percentage, not the SDK estimate', async () => {
    const row = await openMenu()
    expect(host.querySelector('.panel-context-meter')?.getAttribute('title')).toContain('55%')
    expect(host.textContent).not.toContain('暂不可读取')
    expect(row.textContent).toContain('80%')
    expect(row.textContent).not.toContain('97')
    expect(row.getAttribute('aria-valuenow')).toBe('80')
  })

  it('nudges by one point with the wheel and the arrow keys, within 50–90', async () => {
    const row = await openMenu()
    await act(async () => {
      row.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    })
    expect(calls).toEqual([81])
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
    })
    expect(calls).toEqual([81, 79])

    settings.autoCompactPercent = 90
    await act(async () => { root.unmount() })
    root = createRoot(host)
    const boundary = await openMenu()
    await act(async () => {
      boundary.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }))
    })
    expect(calls).toEqual([81, 79])
    settings.autoCompactPercent = 80
  })
})
