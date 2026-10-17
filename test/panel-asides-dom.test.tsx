// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI, TimelineEntry } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** 插话不再把折叠打断：它抬到这一轮的最上面、按条数叠成一列单独可见，
 *  下面整条过程（插话前后的工作）一起折起来——任何时候都能收。 */

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 5, goalMaxMinutes: 30,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small'
}

const conversation: ConversationSummary = {
  id: 'a', title: '会话 a', createdAt: '2026-10-15T00:00:00.000Z', updatedAt: '2026-10-15T00:00:00.000Z',
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'claude_code',
  taskStatus: 'idle', messageCount: 4, preview: ''
}

const at = (seconds: number): string => new Date(Date.parse('2026-10-15T10:00:00.000Z') + seconds * 1000).toISOString()

const timeline: TimelineEntry[] = [
  { id: 'u1', kind: 'user', time: at(0), text: '把配置改一下' },
  { id: 't1', kind: 'thinking', time: at(1), text: '先看配置', endedAt: at(5) },
  { id: 's1', kind: 'user', time: at(6), text: '插话：用另一种方案', interrupted: true },
  { id: 't2', kind: 'thinking', time: at(7), text: '换方案的思路', endedAt: at(9) },
  { id: 'a1', kind: 'assistant', time: at(10), text: '改好了' }
]

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle',
  timeline, timelineRevision: 1, modelReady: true, claudeCodeReady: true,
  conversationId: 'a',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] }
}

describe('a steered line inside a finished turn', () => {
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

  it('stacks the steered line above a process that folds whole', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    const asides = host.querySelector('.panel-turn-asides')
    const process = host.querySelector('.panel-cluster.is-turn-process')
    const reply = host.querySelector('.panel-event-assistant')
    expect(asides).toBeTruthy()
    expect(asides!.textContent).toContain('插话：用另一种方案')
    expect(process).toBeTruthy()
    expect(reply).toBeTruthy()
    // 插话在自己的消息行上、在小鲸的气泡外面：在气泡里假装成它的内容会
    // 让消息看起来"跑错了地方"。
    expect(reply!.contains(asides!)).toBe(false)
    expect(asides!.compareDocumentPosition(reply!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // 也没掉进折叠块——它永远看得见。
    expect(process!.textContent).not.toContain('插话：用另一种方案')
    // 折叠块默认是收起来的：插话前后的工作都在里面，链整条可收。
    expect(process!.hasAttribute('open')).toBe(false)
    expect(process!.textContent).toContain('已工作')
  })

  it('keeps the steered line inside the process while the turn still runs', async () => {
    const live: AppSnapshot = { ...snapshot, taskStatus: 'executing', taskMetrics: { startedAt: at(0) } }
    await act(async () => {
      root.render(<PanelBubble visible snapshot={live} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    // 思考中：插话按顺序留在过程流里，不提前搬到折叠链上方。
    expect(host.querySelector('.panel-turn-asides')).toBeNull()
    expect(host.textContent).toContain('插话：用另一种方案')
  })
})
