// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, ConversationSummary, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const activeId = '11111111-1111-4111-8111-111111111111'
const sourceId = '22222222-2222-4222-8222-222222222222'
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

function conversation(id: string, title: string, messageCount: number): ConversationSummary {
  return { id, title, createdAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T01:00:00Z', lastActivityAt: '2026-10-13T01:00:00Z',
    archivedAt: null, pinnedAt: null, mode: 'claude_code', taskStatus: 'idle', messageCount, preview: '' }
}

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', timeline: [], timelineRevision: 0,
  modelReady: true, claudeCodeReady: true, conversationId: activeId,
  conversationLibrary: { settings, activeConversationId: activeId, conversations: [
    conversation(activeId, '当前会话', 0), conversation(sourceId, '项目计划', 4)
  ] }, contextUsage: { status: 'unavailable' }
}

describe('Claudian style composer discovery', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
    bridge = new Proxy({
      listClaudeWorkflows: async () => [
        { name: 'compact', kind: 'command', source: 'builtin', description: '压缩对话' },
        { name: 'review', kind: 'skill', source: 'user', description: '代码审查' }
      ],
      searchWorkspaceFiles: async () => [
        { name: 'docs', relativePath: 'docs', kind: 'directory' },
        { name: 'README.md', relativePath: 'README.md', kind: 'file' }
      ]
    } as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        if (prop.startsWith('on')) return () => () => {}
        if (prop === 'getContextUsage') return async () => ({ status: 'unavailable' })
        if (prop === 'readAvatar') return async () => null
        return async () => undefined
      }
    }) as unknown as PetAPI
    ;(window as unknown as { pet: PetAPI }).pet = bridge
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
    else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    vi.unstubAllGlobals()
  })

  async function type(value: string): Promise<HTMLTextAreaElement> {
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, value)
      editor.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    })
    return editor
  }

  it('shows $ skills separately and offers files, folders and completed sessions for @', async () => {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot} error={null}
      run={async (action) => { await action(bridge); return true }} />))
    await act(async () => host.querySelector<HTMLElement>('.panel-compose-trigger')!.click())

    await type('$')
    expect([...host.querySelectorAll('.panel-suggestion-item')].map((item) => item.textContent)).toEqual(['$review技能，用户，代码审查'])
    await type('/')
    expect([...host.querySelectorAll('.panel-suggestion-item')].map((item) => item.textContent)).toEqual(['/compact命令，内置，压缩对话'])

    const editor = await type('@')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })
    const options = [...host.querySelectorAll<HTMLElement>('.panel-suggestion-item')]
    expect(options.map((item) => item.textContent)).toEqual([
      '项目计划会话，4 条消息', 'docs目录，docs', 'README.md文件，README.md'
    ])
    await act(async () => options[0].click())
    expect(editor.value).toBe(`@[项目计划](xiaojing-session:${sourceId}) `)
  })

  it('completes the highlighted suggestion with Tab instead of moving focus', async () => {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot} error={null}
      run={async (action) => { await action(bridge); return true }} />))
    await act(async () => host.querySelector<HTMLElement>('.panel-compose-trigger')!.click())

    const editor = await type('/comp')
    expect([...host.querySelectorAll('.panel-suggestion-item')].map((item) => item.textContent)).toEqual(['/compact命令，内置，压缩对话'])
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(editor.value).toBe('/compact ')
  })
})
