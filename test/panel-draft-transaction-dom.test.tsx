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

function summary(id: string): ConversationSummary {
  return { id, title: `会话 ${id}`, createdAt: '2026-10-13T00:00:00.000Z', updatedAt: '2026-10-13T00:00:00.000Z', lastActivityAt: '2026-10-13T00:00:00.000Z',
    archivedAt: null, pinnedAt: null, mode: 'dsh', taskStatus: 'idle', messageCount: 1, preview: '' }
}

function snapshot(activeConversationId: string): AppSnapshot {
  return {
    mode: 'dsh', avatarState: 'idle', taskStatus: 'idle', modelReady: true, dshReady: true,
    conversationId: activeConversationId, timelineRevision: 1,
    timeline: [{ id: 'notice', kind: 'system', text: '准备就绪', time: '2026-10-13T00:00:00.000Z' }],
    conversationLibrary: { settings, activeConversationId, conversations: [summary('a'), summary('b')] },
    contextUsage: { status: 'unavailable' }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function type(editor: HTMLTextAreaElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, value)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}

function enter(editor: HTMLTextAreaElement): void {
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

function drop(host: HTMLElement, name: string): void {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['hello'], name)], types: ['Files'] } })
  host.querySelector('.panel-bubble')!.dispatchEvent(event)
}

describe('composer submissions stay with their conversation', () => {
  let host: HTMLDivElement
  let root: Root
  let pending: ReturnType<typeof deferred<void>>
  let sendMessage: ReturnType<typeof vi.fn>
  let bridge: PetAPI

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      disconnect(): void {}
    })
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    pending = deferred<void>()
    sendMessage = vi.fn(() => pending.promise)
    bridge = new Proxy({
      sendMessage,
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

  async function render(activeId: string): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot(activeId)} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
  }

  async function openComposer(): Promise<HTMLTextAreaElement> {
    if (!host.querySelector('textarea[aria-label="输入消息"]')) {
      await act(async () => click(host.querySelector('.panel-compose-trigger')!))
    }
    return host.querySelector('textarea[aria-label="输入消息"]')!
  }

  async function switchTo(id: string): Promise<void> {
    await act(async () => click(host.querySelector(`[data-tab-id="${id}"]`)!))
    await render(id)
  }

  it('restores a failed send and later text/files only in its original conversation', async () => {
    await render('a')
    const editor = await openComposer()
    await act(async () => { type(editor, '原消息'); drop(host, 'original.txt') })
    await act(async () => enter(editor))
    expect(sendMessage).toHaveBeenCalledWith('原消息', [{ name: 'original.txt', content: '', path: 'C:\\workspace\\original.txt' }], 'queue', 'a')

    await act(async () => { type(editor, '之后输入'); drop(host, 'later.txt') })
    await switchTo('b')
    const otherEditor = await openComposer()
    await act(async () => type(otherEditor, '另一会话'))
    await act(async () => pending.reject(new Error('发送失败')))
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value).toBe('另一会话')
    expect(host.querySelectorAll('.panel-attachment-chip')).toHaveLength(0)

    await switchTo('a')
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value).toBe('原消息\n\n之后输入')
    expect([...host.querySelectorAll('.panel-attachment-chip')].map((chip) => chip.textContent)).toEqual(['TXToriginal×', 'TXTlater×'])
  })

  it('restores a rejected goal prompt in its original conversation', async () => {
    await render('a')
    const editor = await openComposer()
    await act(async () => click(host.querySelector('.panel-model-button')!))
    await act(async () => click([...host.querySelectorAll('.panel-mode-toggle')].find((item) => item.textContent?.includes('目标模式'))!))
    await act(async () => type(editor, '整理项目'))
    await act(async () => enter(editor))
    expect(sendMessage).toHaveBeenCalledWith('/goal 整理项目', [], 'queue', 'a')

    await switchTo('b')
    const otherEditor = await openComposer()
    await act(async () => type(otherEditor, 'B 的草稿'))
    await act(async () => pending.reject(new Error('目标发送失败')))
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!.value).toBe('B 的草稿')

    await switchTo('a')
    const restored = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')!
    expect(restored.value).toBe('整理项目')
    expect(restored.placeholder).toBe('写清目标，回车设定；按 Tab 补上“在把我交代的任务全部完成之前不要停下”')
  })

  it('allows B to send while A is pending and keeps each conversation locked independently', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    sendMessage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    await render('a')
    const editor = await openComposer()
    await act(async () => type(editor, 'A 的消息'))
    await act(async () => enter(editor))
    expect(sendMessage).toHaveBeenNthCalledWith(1, 'A 的消息', [], 'queue', 'a')

    await switchTo('b')
    const otherEditor = await openComposer()
    await act(async () => type(otherEditor, 'B 的消息'))
    const sendButton = host.querySelector<HTMLButtonElement>('.panel-send')!
    expect(sendButton.disabled).toBe(false)
    expect(sendButton.getAttribute('aria-label')).toBe('发送消息')
    await act(async () => enter(otherEditor))
    expect(sendMessage).toHaveBeenNthCalledWith(2, 'B 的消息', [], 'queue', 'b')

    await act(async () => type(otherEditor, 'B 的下一条'))
    await act(async () => enter(otherEditor))
    expect(sendMessage).toHaveBeenCalledTimes(2)
    expect(otherEditor.value).toBe('B 的下一条')
    expect(host.querySelector<HTMLButtonElement>('.panel-send')?.disabled).toBe(true)

    await act(async () => first.resolve())
    expect(host.querySelector<HTMLButtonElement>('.panel-send')?.disabled).toBe(true)
    expect(host.querySelector('.panel-send')?.getAttribute('aria-label')).toBe('发送中…')
    await act(async () => second.resolve())
    expect(host.querySelector<HTMLButtonElement>('.panel-send')?.disabled).toBe(false)
    expect(otherEditor.value).toBe('B 的下一条')
  })

  it('never closes the composer on Escape; the key only interrupts', async () => {
    await render('a')
    const editor = await openComposer()
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true, isComposing: true
    })))
    expect(host.querySelector('.panel-composer')?.className).not.toContain('is-closing')
    await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    expect(host.querySelector('.panel-composer')?.className).not.toContain('is-closing')
  })
})
