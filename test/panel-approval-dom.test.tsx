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
  lastActivityAt: '2026-10-15T00:00:00.000Z', archivedAt: null, pinnedAt: null, mode: 'claude_code',
  taskStatus: 'idle', messageCount: 1, preview: ''
}

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle',
  timeline: [{ id: 'u1', kind: 'user', time: '2026-10-15T10:00:00.000Z', text: '你好' }],
  timelineRevision: 1, modelReady: true, claudeCodeReady: true, conversationId: 'a',
  approvalMode: 'default',
  conversationLibrary: { settings, activeConversationId: 'a', conversations: [conversation] }
}

describe('the approval-mode control', () => {
  let host: HTMLDivElement
  let root: Root
  let calls: Array<[string, ...unknown[]]>

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    calls = []
    const bridge = new Proxy({} as Record<string, unknown>, {
      get(_target, prop: string) {
        if (String(prop).startsWith('on')) return () => () => {}
        if (prop === 'getDraft') return () => Promise.resolve('')
        if (prop === 'getContextUsage') return () => Promise.resolve({ status: 'unavailable' })
        if (prop === 'readAvatar') return () => Promise.resolve(null)
        if (prop === 'listClaudeWorkflows') return () => Promise.resolve([])
        if (prop === 'searchWorkspaceFiles') return () => Promise.resolve([])
        return (...args: unknown[]) => {
          calls.push([String(prop), ...args])
          return Promise.resolve(true)
        }
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

  it('shows the current mode and offers all four choices', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    await act(async () => { host.querySelector<HTMLElement>('.panel-compose-trigger')!.click() })
    const trigger = host.querySelector<HTMLElement>('.panel-approval-button')!
    // Icon only: the mode lives in the aria-label/title, not as a word on the bar.
    expect(trigger.textContent).toBe('')
    expect(trigger.getAttribute('aria-label')).toBe('审批模式：手动审批')
    await act(async () => { trigger.click() })
    const text = host.querySelector('.panel-approval-menu')?.textContent ?? ''
    expect(text).toContain('手动审批')
    expect(text).toContain('允许所有编辑')
    expect(text).toContain('完全访问')
    expect(text).not.toContain('计划模式')
  })

  it('switches the conversation to the chosen mode', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    await act(async () => { host.querySelector<HTMLElement>('.panel-compose-trigger')!.click() })
    await act(async () => { host.querySelector<HTMLElement>('.panel-approval-button')!.click() })
    const picks = [...host.querySelectorAll<HTMLElement>('.panel-approval-pick')]
    const edits = picks.find((item) => item.textContent?.includes('允许所有编辑'))!
    await act(async () => { edits.click() })
    expect(calls).toContainEqual(['setApprovalMode', 'acceptEdits'])
  })

  it('warns before full access and only switches after the warning is acknowledged', async () => {
    await act(async () => {
      root.render(<PanelBubble visible snapshot={snapshot} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    await act(async () => { host.querySelector<HTMLElement>('.panel-compose-trigger')!.click() })
    await act(async () => { host.querySelector<HTMLElement>('.panel-approval-button')!.click() })
    const bypass = [...host.querySelectorAll<HTMLElement>('.panel-approval-pick')]
      .find((item) => item.textContent?.includes('完全访问'))!
    await act(async () => { bypass.click() })
    // Nothing has switched yet; the warning is up instead.
    expect(calls.some(([name]) => name === 'setApprovalMode')).toBe(false)
    const warning = host.querySelector('.panel-bypass')
    expect(warning?.textContent).toContain('开启「完全访问」')
    expect(warning?.textContent).toContain('风险')
    await act(async () => { host.querySelector<HTMLElement>('.panel-bypass-confirm')!.click() })
    expect(calls).toContainEqual(['setApprovalMode', 'bypassPermissions'])
    expect(host.querySelector('.panel-bypass')).toBeNull()
  })

  it('parks a tool call in the composer slot and forwards allow/deny', async () => {
    const waiting: AppSnapshot = {
      ...snapshot,
      permission: { id: 'p1', tool: 'Bash', summary: '执行命令：npm test', input: '{"command":"npm test"}' }
    }
    await act(async () => {
      root.render(<PanelBubble visible snapshot={waiting} error={null} run={async (action) => { await action(window.pet); return true }} />)
    })
    const card = host.querySelector('.panel-permission')
    expect(card?.textContent).toContain('需要允许')
    expect(card?.textContent).toContain('执行命令：npm test')
    await act(async () => { host.querySelector<HTMLElement>('.panel-permission-allow')!.click() })
    expect(calls).toContainEqual(['answerPermission', 'p1', true])
  })
})
