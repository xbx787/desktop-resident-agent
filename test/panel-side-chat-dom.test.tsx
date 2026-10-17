// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSnapshot, ConversationSettings, PetAPI, SideChatSnapshot } from '../src/shared/contracts'
import { PanelBubble } from '../src/renderer/panel'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30, goalMaxMinutes: 180,
  memoryEnabled: true, effort: 'high', modelProfiles: [], activeModelProfileId: null,
  enableAutoTitleGeneration: true, showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small'
}

const mainSnapshot: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', modelReady: true, claudeCodeReady: true,
  conversationId: 'main-a', timelineRevision: 1,
  timeline: [{ id: 'main-entry', kind: 'assistant', time: '2026-10-15T10:00:00.000Z', text: '主线里的内容' }],
  conversationLibrary: {
    settings, activeConversationId: 'main-a',
    conversations: [{ id: 'main-a', title: '主线', createdAt: '2026-10-15T10:00:00.000Z',
      updatedAt: '2026-10-15T10:00:00.000Z', lastActivityAt: '2026-10-15T10:00:00.000Z',
      archivedAt: null, pinnedAt: null, mode: 'claude_code', taskStatus: 'idle', messageCount: 1, preview: '' }]
  }
}

const sideRuntime: AppSnapshot = {
  mode: 'claude_code', avatarState: 'idle', taskStatus: 'idle', modelReady: true, claudeCodeReady: true,
  conversationId: 'side-1', timelineRevision: 1,
  timeline: [{ id: 'side-entry', kind: 'assistant', time: '2026-10-15T10:01:00.000Z', text: '临时会话里的内容' }]
}

const emptySide = (parentConversationId = 'main-a'): SideChatSnapshot => ({ sessionId: null, parentConversationId,
  expanded: false, queuePaused: false, snapshot: null, pendingMessages: [] })
const side = (expanded = true, runtime = sideRuntime): SideChatSnapshot => ({
  sessionId: 'side-1', parentConversationId: 'main-a', expanded, queuePaused: false,
  snapshot: runtime, pendingMessages: []
})

const sideB = (expanded = true): SideChatSnapshot => ({
  sessionId: 'side-b', parentConversationId: 'main-b', expanded, queuePaused: false,
  snapshot: { ...sideRuntime, conversationId: 'side-b',
    timeline: [{ id: 'side-b-entry', kind: 'assistant', time: '2026-10-15T10:04:00.000Z', text: 'B 临时会话里的内容' }] },
  pendingMessages: []
})

function selectedMain(id: 'main-a' | 'main-b'): AppSnapshot {
  const first = mainSnapshot.conversationLibrary!.conversations[0]
  const second = { ...first, id: 'main-b', title: 'B 主线', preview: 'B 的对话' }
  return {
    ...mainSnapshot, conversationId: id, timelineRevision: id === 'main-a' ? 1 : 2,
    timeline: id === 'main-a' ? mainSnapshot.timeline
      : [{ id: 'main-b-entry', kind: 'assistant', time: '2026-10-15T10:03:00.000Z', text: 'B 主线里的内容' }],
    conversationLibrary: { ...mainSnapshot.conversationLibrary!, activeConversationId: id,
      conversations: [first, second] }
  }
}

function switchedMain(action: 'archive' | 'delete'): AppSnapshot {
  const first = mainSnapshot.conversationLibrary!.conversations[0]
  const second = { ...first, id: 'main-b', title: 'B 主线', preview: 'B 的对话' }
  return {
    ...mainSnapshot, conversationId: 'main-b', timelineRevision: 2,
    timeline: [{ id: 'main-b-entry', kind: 'assistant', time: '2026-10-15T10:03:00.000Z', text: 'B 主线里的内容' }],
    conversationLibrary: {
      ...mainSnapshot.conversationLibrary!, activeConversationId: 'main-b',
      conversations: action === 'archive'
        ? [{ ...first, archivedAt: '2026-10-15T10:03:00.000Z' }, second]
        : [second]
    }
  }
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

describe('temporary side chat stays in the same panel', () => {
  let host: HTMLDivElement
  let root: Root
  let bridge: PetAPI
  let sideListeners: Set<(next: SideChatSnapshot) => void>
  let sendMain: ReturnType<typeof vi.fn>
  let sendSide: ReturnType<typeof vi.fn>
  let saveDraft: ReturnType<typeof vi.fn>
  let getDraft: ReturnType<typeof vi.fn>
  let stopMain: ReturnType<typeof vi.fn>
  let stopSide: ReturnType<typeof vi.fn>
  let removeSideQueuedMessage: ReturnType<typeof vi.fn>
  let removeQueuedMessage: ReturnType<typeof vi.fn>
  let listClaudeWorkflows: ReturnType<typeof vi.fn>
  let prepareDroppedFile: ReturnType<typeof vi.fn>
  let sideRuntimeState: AppSnapshot

  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(callback, 0))
    Element.prototype.scrollIntoView = vi.fn()
    sideListeners = new Set()
    sideRuntimeState = sideRuntime
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    saveDraft = vi.fn(async () => undefined)
    getDraft = vi.fn(async (id: string) => id === 'main-b' ? 'B 保存的草稿' : '')
    sendSide = vi.fn(async () => undefined)
    stopMain = vi.fn(async () => undefined)
    stopSide = vi.fn(async () => undefined)
    removeSideQueuedMessage = vi.fn(async () => undefined)
    removeQueuedMessage = vi.fn(async () => undefined)
    listClaudeWorkflows = vi.fn(async () => [
      ...['new', 'side', 'btw', 'sessions', 'model', 'help', 'compact', 'goal', 'review'].map((name) =>
        ({ name, description: '', kind: 'command' as const, source: 'builtin' as const }))
    ])
    prepareDroppedFile = vi.fn(async (filePath: string) => ({ name: filePath.split('\\').at(-1)!, content: '', path: filePath }))
    sendMain = vi.fn(async (text: string) => {
      if (/^\/(?:side|btw)(?:\s|$)/u.test(text)) for (const listener of sideListeners) listener(side())
    })
    const setSideChatExpanded = vi.fn(async (_id: string, expanded: boolean) => {
      const next = side(expanded, sideRuntimeState)
      for (const listener of sideListeners) listener(next)
      return next
    })
    bridge = new Proxy({
      sendMessage: sendMain, sendSideChatMessage: sendSide, stop: stopMain, stopSideChat: stopSide,
      removeSideQueuedMessage, removeQueuedMessage,
      getPathForFile: (file: File) => `C:\\workspace\\${file.name}`,
      prepareDroppedFile, listClaudeWorkflows,
      saveDraft, getDraft, getSideChat: async () => emptySide(), setSideChatExpanded,
      onSideChatSnapshot: (listener: (next: SideChatSnapshot) => void) => {
        sideListeners.add(listener)
        return () => { sideListeners.delete(listener) }
      }
    } as Record<string, unknown>, {
      get(target, property: string) {
        if (property in target) return target[property]
        if (property.startsWith('on')) return () => () => {}
        if (property === 'getDraft') return async () => ''
        if (property === 'getContextUsage' || property === 'getSideChatContextUsage') return async () => ({ status: 'unavailable' })
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

  async function mount(snapshot: AppSnapshot = mainSnapshot): Promise<void> {
    await act(async () => root.render(<PanelBubble visible snapshot={snapshot} error={null}
      run={async (action) => { try { await action(bridge); return true } catch { return false } }} />))
  }

  async function editor(): Promise<HTMLTextAreaElement> {
    let input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')
    if (!input) {
      await act(async () => click(host.querySelector('.panel-compose-trigger')!))
      input = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="输入消息"]')
    }
    return input!
  }

  async function publishSide(next: SideChatSnapshot): Promise<void> {
    await act(async () => { for (const listener of sideListeners) listener(next) })
  }

  it('opens /side without adding a main message and routes later sends to the side runtime', async () => {
    await mount()
    const input = await editor()
    await act(async () => { type(input, '/side 先问个旁支问题'); enter(input) })
    expect(sendMain).toHaveBeenCalledWith('/side 先问个旁支问题', [], 'queue', 'main-a')
    expect(host.textContent).toContain('临时会话里的内容')
    expect(host.textContent).not.toContain('主线里的内容')
    expect(host.textContent).toContain('临时会话，记录不进入会话库')
    await act(async () => { type(input, '继续临时会话'); enter(input) })
    expect(sendSide).toHaveBeenCalledWith('side-1', '继续临时会话', [], 'queue')
    expect(sendMain).toHaveBeenCalledTimes(1)
  })

  it('keeps separate drafts and never persists a side draft as the main draft', async () => {
    await mount()
    const input = await editor()
    await act(async () => { type(input, '主线草稿') })
    await act(async () => { for (const listener of sideListeners) listener(side()) })
    expect(input.value).toBe('')
    await act(async () => { type(input, '临时会话草稿') })
    await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
    expect(input.value).toBe('主线草稿')
    expect(host.textContent).toContain('主线里的内容')
    expect(host.textContent).not.toContain('临时会话里的内容')
    await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
    expect(input.value).toBe('临时会话草稿')
    expect(saveDraft.mock.calls.every(([_, value]) => value !== '临时会话草稿')).toBe(true)
  })

  it.each(['side-first', 'main-first'] as const)(
    'restores each parent side draft, attachment, and composer state across A -> B -> A when %s', async (order) => {
      await mount(selectedMain('main-a'))
      await editor()
      await publishSide(side())
      await act(async () => { type((await editor()), 'A 临时会话未发出的内容'); drop(host, 'A-note.docx') })
      await act(async () => click(host.querySelector('button[aria-label="收起输入框"]')!))
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 250)) })
      expect(host.querySelector('textarea[aria-label="输入消息"]')).toBeNull()

      if (order === 'side-first') {
        await publishSide(sideB())
        expect(host.textContent).toContain('临时会话里的内容')
        await mount(selectedMain('main-b'))
      } else {
        await mount(selectedMain('main-b'))
        expect(host.textContent).toContain('B 主线里的内容')
        await publishSide(sideB())
      }
      expect(host.textContent).toContain('B 临时会话里的内容')
      expect((await editor()).value).toBe('')
      await act(async () => { type((await editor()), 'B 临时会话未发出的内容'); drop(host, 'B-note.pdf') })

      if (order === 'side-first') {
        await publishSide(side())
        expect((await editor()).value).toBe('B 临时会话未发出的内容')
        await mount(selectedMain('main-a'))
      } else {
        await mount(selectedMain('main-a'))
        await publishSide(side())
      }
      expect(host.textContent).toContain('临时会话里的内容')
      expect(host.textContent).not.toContain('B 临时会话里的内容')
      expect(host.querySelector('textarea[aria-label="输入消息"]')).toBeNull()
      const aInput = await editor()
      expect(aInput.value).toBe('A 临时会话未发出的内容')
      expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('A-note')
      expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).not.toContain('B-note')

      await mount(selectedMain('main-b'))
      expect((await editor()).value).toBe('B 临时会话未发出的内容')
      expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('B-note')
      expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).not.toContain('A-note')
      expect(saveDraft.mock.calls.every(([_, value]) => !value.includes('临时会话未发出的内容'))).toBe(true)
    }
  )

  it.each(['side-first', 'main-first'] as const)(
    'keeps A folded side when B has no side and %s event arrives first', async (order) => {
      await mount(selectedMain('main-a'))
      await editor()
      await publishSide(side())
      await act(async () => type((await editor()), '折叠的 A 临时会话草稿'))
      await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
      expect(host.querySelector('button[aria-label^="展开临时会话"]')).not.toBeNull()
      if (order === 'side-first') {
        await publishSide(emptySide('main-b'))
        expect(host.querySelector('button[aria-label^="展开临时会话"]')).not.toBeNull()
        await mount(selectedMain('main-b'))
      } else {
        await mount(selectedMain('main-b'))
        await publishSide(emptySide('main-b'))
      }
      expect(host.querySelector('[aria-label="临时会话"]')).toBeNull()
      expect((await editor()).value).toBe('B 保存的草稿')
      await mount(selectedMain('main-a'))
      expect(host.querySelector('button[aria-label^="展开临时会话"]')).not.toBeNull()
      await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
      expect((await editor()).value).toBe('折叠的 A 临时会话草稿')
    }
  )

  it('does not reuse a discarded side draft for a new side session under the same parent', async () => {
    await mount(selectedMain('main-a'))
    await editor()
    await publishSide(side())
    await act(async () => type((await editor()), '旧临时会话草稿'))
    await publishSide(emptySide('main-a'))
    await publishSide({ ...side(), sessionId: 'side-new', snapshot: { ...sideRuntime, conversationId: 'side-new' } })
    expect((await editor()).value).toBe('')
  })

  it('returns a late A file preparation to A after switching to B side', async () => {
    await mount(selectedMain('main-a'))
    await editor()
    await publishSide(side())
    let finishFile!: (attachment: { name: string; content: string; path: string }) => void
    prepareDroppedFile.mockImplementationOnce(() => new Promise((resolve) => { finishFile = resolve }))
    await act(async () => { drop(host, 'late-A.docx') })
    await mount(selectedMain('main-b'))
    await publishSide(sideB())
    await act(async () => finishFile({ name: 'late-A.docx', content: '', path: 'C:\\workspace\\late-A.docx' }))
    expect(host.querySelector('[aria-label="已添加附件"]')).toBeNull()
    await mount(selectedMain('main-a'))
    expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('late-A')
  })

  it('lets B send while A side submission is still waiting', async () => {
    let releaseA!: () => void
    sendSide.mockImplementation((id: string) => id === 'side-1'
      ? new Promise<void>((resolve) => { releaseA = resolve }) : Promise.resolve())
    await mount(selectedMain('main-a'))
    await editor()
    await publishSide(side())
    await act(async () => { const input = await editor(); type(input, 'A 正在发送'); enter(input) })
    expect(sendSide).toHaveBeenCalledWith('side-1', 'A 正在发送', [], 'queue')
    await mount(selectedMain('main-b'))
    await publishSide(sideB())
    await act(async () => { const input = await editor(); type(input, 'B 可以发送'); enter(input) })
    expect(sendSide).toHaveBeenCalledWith('side-b', 'B 可以发送', [], 'queue')
    await act(async () => releaseA())
  })

  it('uses Escape to stop only the expanded side task', async () => {
    await mount()
    await act(async () => { for (const listener of sideListeners) listener(side(true, { ...sideRuntime, taskStatus: 'executing' })) })
    await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(stopSide).toHaveBeenCalledWith('side-1')
    expect(stopMain).not.toHaveBeenCalled()
  })

  it('keeps dropped files in the side draft while the main composer is selected', async () => {
    await mount()
    await editor()
    await act(async () => { for (const listener of sideListeners) listener(side()) })
    await act(async () => { drop(host, 'brief.docx') })
    expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('brief')
    await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
    expect(host.querySelector('[aria-label="已添加附件"]')).toBeNull()
    await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
    expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('brief')
    await act(async () => { type((await editor()), '看看文件'); enter((await editor())) })
    expect(sendSide).toHaveBeenCalledWith('side-1', '看看文件', [
      { name: 'brief.docx', content: '', path: 'C:\\workspace\\brief.docx' }
    ], 'queue')
    let finishFile!: (attachment: { name: string; content: string; path: string }) => void
    prepareDroppedFile.mockImplementationOnce(() => new Promise((resolve) => { finishFile = resolve }))
    await act(async () => { drop(host, 'later.txt') })
    await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
    await act(async () => finishFile({ name: 'later.txt', content: '', path: 'C:\\workspace\\later.txt' }))
    expect(host.querySelector('[aria-label="已添加附件"]')).toBeNull()
    await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
    expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('later')
  })

  it('restores the visible main draft when opening /side fails after a side snapshot arrived', async () => {
    sendMain.mockImplementation(async () => {
      for (const listener of sideListeners) listener(side())
      for (const listener of sideListeners) listener(emptySide())
      throw new Error('source rejected')
    })
    await mount()
    const input = await editor()
    await act(async () => { type(input, '/side 失败后保留的问题'); enter(input) })
    expect(input.value).toBe('/side 失败后保留的问题')
    expect(host.textContent).toContain('主线里的内容')
    expect(host.querySelector('[aria-label="临时会话"]')).toBeNull()
    expect(sendSide).not.toHaveBeenCalled()
    expect(saveDraft.mock.calls.some(([id, value]) => id === 'main-a' && value === '/side 失败后保留的问题')).toBe(false)
  })

  it('shows a running collapsed side chip and keeps main-only slash commands out of side suggestions', async () => {
    await mount()
    const input = await editor()
    await act(async () => { type(input, '/'); })
    expect(host.querySelector('[aria-label="选择命令"]')?.textContent).toContain('填写问题后开启临时会话')
    sideRuntimeState = { ...sideRuntime, taskStatus: 'executing' }
    await act(async () => { for (const listener of sideListeners) listener(side(true, sideRuntimeState)) })
    await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
    expect(host.querySelector('button[aria-label="展开临时会话，正在执行"]')).not.toBeNull()
    await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
    await act(async () => { type(input, '/'); })
    const choices = host.querySelector('[aria-label="选择命令"]')?.textContent ?? ''
    expect(choices).toContain('/review')
    for (const name of ['new', 'side', 'btw', 'sessions', 'model', 'help', 'goal', 'compact']) {
      expect(choices).not.toContain(`/${name}`)
    }
    await act(async () => { type(input, '/new') })
    await act(async () => { enter(input) })
    expect(input.value).toBe('/new')
    expect(host.textContent).toContain('/new 仅适用于主线')
    expect(sendSide).not.toHaveBeenCalled()
    expect(sendMain).not.toHaveBeenCalled()
  })

  it('restores a side queued text attachment to its own composer after a collapse, then resends the content', async () => {
    await mount()
    const queued = { id: 'side-queue-1', text: '待发正文', createdAt: '2026-10-15T10:02:00.000Z',
      attachments: [{ name: 'note.txt', content: '只给临时会话的文字', path: 'C:\\workspace\\note.txt' }] }
    await act(async () => { for (const listener of sideListeners) listener({ ...side(), pendingMessages: [queued] }) })
    let releaseRemove!: () => void
    removeSideQueuedMessage.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseRemove = resolve }))
    await act(async () => click(host.querySelector('button[aria-label="修改待发送消息：待发正文"]')!))
    await act(async () => click(host.querySelector('button[aria-label="收起临时会话，返回主线"]')!))
    await act(async () => releaseRemove())
    expect((await editor()).value).toBe('')
    expect(host.querySelector('[aria-label="已添加附件"]')).toBeNull()
    await act(async () => click(host.querySelector('button[aria-label^="展开临时会话"]')!))
    const sideInput = await editor()
    expect(sideInput.value).toBe('待发正文')
    expect(host.querySelector('[aria-label="已添加附件"]')?.textContent).toContain('note')
    await act(async () => enter(sideInput))
    expect(removeSideQueuedMessage).toHaveBeenCalledWith('side-1', 'side-queue-1')
    expect(removeQueuedMessage).not.toHaveBeenCalled()
    expect(sendSide).toHaveBeenCalledWith('side-1', '待发正文', queued.attachments, 'queue')
    expect(sendMain).not.toHaveBeenCalled()
  })

  it.each([
    ['archive', 'side-first'],
    ['delete', 'main-first']
  ] as const)('keeps A draft out of B after %s when %s snapshot arrives first', async (action, order) => {
    await mount()
    const input = await editor()
    await act(async () => type(input, 'A 私有草稿'))
    await act(async () => { for (const listener of sideListeners) listener(side()) })
    await act(async () => type(input, 'A 临时会话草稿'))
    if (order === 'side-first') {
      await act(async () => { for (const listener of sideListeners) listener(emptySide('main-b')) })
      expect(input.value).toBe('A 临时会话草稿')
      await mount(switchedMain(action))
    } else {
      await mount(switchedMain(action))
      await act(async () => { for (const listener of sideListeners) listener(emptySide('main-b')) })
    }
    const nextInput = await editor()
    expect(nextInput.value).toBe('B 保存的草稿')
    expect(host.textContent).toContain('B 主线里的内容')
    expect(host.querySelector('[data-entry-id="main-entry"]')).toBeNull()
    expect(host.querySelector('[aria-label="临时会话"]')).toBeNull()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)) })
    expect(saveDraft.mock.calls.every(([id, value]) => id !== 'main-b' || value !== 'A 私有草稿')).toBe(true)
    expect(saveDraft.mock.calls.every(([id, value]) => id !== 'main-b' || value !== 'A 临时会话草稿')).toBe(true)
    if (action === 'archive') {
      await act(async () => { for (const listener of sideListeners) listener(side()) })
      await mount(mainSnapshot)
      expect((await editor()).value).toBe('A 私有草稿')
      expect(host.querySelector('[aria-label="临时会话"]')).toBeNull()
    }
  })
})
