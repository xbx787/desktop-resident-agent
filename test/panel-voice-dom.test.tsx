// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, PetAPI } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const activeId = '11111111-1111-4111-8111-111111111111'

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

const snapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', timeline: [], timelineRevision: 0,
  modelReady: true, claudeCodeReady: true, conversationId: activeId,
  conversationLibrary: { settings, activeConversationId: activeId, conversations: [
    { id: activeId, title: '当前会话', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z',
      lastActivityAt: '2026-10-18T00:00:00Z', archivedAt: null, pinnedAt: null, mode: 'claude_code',
      taskStatus: 'idle', messageCount: 0, preview: '' }
  ] }, contextUsage: { status: 'unavailable' }
}

describe('panel voice button', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI
  let openedSettings: number

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: () => {} })
    openedSettings = 0
    bridge = new Proxy({
      getVoiceConfig: async () => ({ siliconFlowAvailable: false, ttsAvailable: false }),
      onVoiceConfigChanged: () => () => undefined,
      openSettings: async () => { openedSettings += 1 }
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
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
    vi.unstubAllGlobals()
  })

  async function openComposer(): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot} error={null}
      run={async (action) => { await action(bridge); return true }} />))
    await act(async () => host.querySelector<HTMLElement>('.panel-compose-trigger')!.click())
    await act(async () => { await Promise.resolve() })
  }

  it('sits between the context meter and the send button', async () => {
    await openComposer()
    const toolbar = host.querySelector('.panel-composer-toolbar')!
    const meter = toolbar.querySelector('.panel-context-meter')!
    const mic = toolbar.querySelector('.panel-microphone-button')!
    const send = toolbar.querySelector('.panel-send')!
    expect(mic).not.toBeNull()
    expect(Boolean(meter.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(mic.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
  })

  it('opens settings when voice is not configured', async () => {
    await openComposer()
    await act(async () => host.querySelector<HTMLElement>('.panel-microphone-button')!.click())
    expect(openedSettings).toBe(1)
    expect(host.textContent).toContain('还没有配置语音服务')
  })
})
