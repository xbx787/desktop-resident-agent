// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The panel with nothing to show: a bubble that still has conversations folds
 *  into the little ball, but once the last one is closed the full panel stays —
 *  the ball has no tab strip and no room for the "+", and starting a fresh
 *  conversation is the one thing left to do. */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: []
}

function summary(id: string, archivedAt: string | null): ConversationSummary {
  return { id, title: `会话 ${id}`, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', lastActivityAt: '2026-10-13T00:00:00.000Z', archivedAt, pinnedAt: null, mode: 'claude_code', taskStatus: 'idle', messageCount: 0, preview: '' }
}

const bridge = new Proxy({} as Record<string, unknown>, {
  get(_target, prop: string) {
    if (String(prop).startsWith('on')) return () => () => {}
    if (prop === 'getContextUsage') return () => Promise.resolve({ status: 'unavailable' })
    if (prop === 'readAvatar') return () => Promise.resolve(null)
    if (prop === 'listClaudeWorkflows') return () => Promise.resolve([])
    if (prop === 'searchWorkspaceFiles') return () => Promise.resolve([])
    return () => Promise.resolve(undefined)
  }
}) as unknown as PetAPI

function snapshotWith(conversations: ConversationSummary[], activeConversationId: string | null): AppSnapshot {
  return {
    mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle',
    timeline: [], timelineRevision: 0, modelReady: true, claudeCodeReady: true,
    conversationId: activeConversationId ?? undefined,
    conversationLibrary: { settings, activeConversationId, conversations },
    contextUsage: { status: 'unavailable' }
  }
}

describe('the empty panel with no conversations left', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    (window as unknown as { pet: PetAPI }).pet = bridge
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
  })

  const mount = async (snapshot: AppSnapshot): Promise<void> => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(bridge); return true }} />)
    })
  }

  it('keeps the full panel and the "+" when every conversation is gone', async () => {
    await mount(snapshotWith([summary('a', '2026-10-12T00:00:00.000Z')], null))
    const bubble = host.querySelector('.panel-bubble')!
    expect(bubble.className).not.toContain('is-empty')
    expect(host.querySelector('.panel-quick-tabs')).toBeTruthy()
    expect(host.querySelector('.panel-quick-tab-new')).toBeTruthy()
    expect(host.querySelectorAll('.panel-quick-tab[data-tab-id]')).toHaveLength(0)
  })

  it('still folds into the ball when an empty conversation exists', async () => {
    await mount(snapshotWith([summary('a', null)], 'a'))
    expect(host.querySelector('.panel-bubble')!.className).toContain('is-empty')
  })
})
