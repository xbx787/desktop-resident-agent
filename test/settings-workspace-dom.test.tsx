// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import type { ConversationSettings } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30,
  goalMaxMinutes: 180, memoryEnabled: true, effort: 'max', modelProfiles: [],
  activeModelProfileId: null, enableAutoTitleGeneration: true,
  showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  Reflect.deleteProperty(window, 'whaleSettings')
  root = undefined
  container = undefined
})

function click(label: string): void {
  const button = [...(container?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.trim() === label)
  if (!button) throw new Error(`找不到按钮：${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function bridge(overrides: Partial<SettingsAPI> = {}): SettingsAPI {
  return {
    get: async () => settings, update: async (patch) => ({ ...settings, ...patch }),
    version: async () => '0.0.75', close: async () => {}, quit: async () => {}, restart: async () => {}, setAvatar: async () => {},
    workspace: async () => ({ path: 'D:\\old', saved: false }),
    pickWorkspace: async () => null,
    migrateWorkspace: async (next) => ({ path: next }),
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
    libraries: async () => ({ items: [], busy: false }),
    searchLibraryMarket: async () => [], installLibrary: async () => ({ items: [], busy: false }),
    removeLibrary: async () => ({ items: [], busy: false }),
    memoryList: async () => [], memorySetEnabled: async (enabled) => enabled,
    memoryUpdate: async (id, text) => ({ id, text, sourceConversationId: 'conversation-1', sourceAt: '2026-10-12T10:00:00.000Z', createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z' }),
    memoryDelete: async () => {},
    growthStatus: async () => ({ available: true, proposals: [] }),
    growthPropose: async () => { throw new Error('unused') },
    growthExperiment: async () => { throw new Error('unused') },
    growthAdopt: async () => { throw new Error('unused') },
    growthPublish: async () => { throw new Error('unused') },
    growthDiscard: async () => { throw new Error('unused') },
    growthUpdateNotes: async () => { throw new Error('unused') },
    ...overrides
  }
}

async function mount(api: SettingsAPI): Promise<void> {
  Object.defineProperty(window, 'whaleSettings', { configurable: true, value: api })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<SettingsPage />))
}

describe('settings quit control', () => {
  it('asks before restarting the whole app', async () => {
    const restart = vi.fn(async () => {})
    await mount(bridge({ restart }))

    await act(async () => click('重启小鲸'))
    expect(container!.textContent).toContain('重启后对话会保存')
    expect(restart).not.toHaveBeenCalled()

    await act(async () => click('确认重启'))
    expect(restart).toHaveBeenCalledTimes(1)
  })

  it('asks before closing the whole app', async () => {
    const quit = vi.fn(async () => {})
    await mount(bridge({ quit }))

    await act(async () => click('退出小鲸'))
    expect(container!.textContent).toContain('退出后对话会保存')
    expect(quit).not.toHaveBeenCalled()

    await act(async () => click('确认退出'))
    expect(quit).toHaveBeenCalledTimes(1)
  })
})

describe('settings workspace migration', () => {
  it('asks for confirmation and only then migrates', async () => {
    const migrate = vi.fn(async (next: string) => ({ path: next }))
    await mount(bridge({ pickWorkspace: async () => 'D:\\new', migrateWorkspace: migrate }))

    expect(container!.textContent).toContain('D:\\old')
    await act(async () => click('迁移工作目录…'))
    expect(container!.textContent).toContain('确认迁移')

    await act(async () => click('确认迁移'))
    expect(migrate).toHaveBeenCalledWith('D:\\new')
    expect(container!.textContent).toContain('D:\\new')
    expect(container!.querySelector('[role="alertdialog"]')).toBeNull()
  })

  it('leaves the workspace alone when the confirmation is cancelled', async () => {
    const migrate = vi.fn(async (next: string) => ({ path: next }))
    await mount(bridge({ pickWorkspace: async () => 'D:\\new', migrateWorkspace: migrate }))

    await act(async () => click('迁移工作目录…'))
    await act(async () => click('取消'))
    expect(migrate).not.toHaveBeenCalled()
    expect(container!.textContent).toContain('D:\\old')
  })

  it('shows the refusal when a task is still running', async () => {
    const migrate = vi.fn(async () => { throw new Error('有任务正在运行，完成后再迁移工作目录。') })
    await mount(bridge({ pickWorkspace: async () => 'D:\\new', migrateWorkspace: migrate }))

    await act(async () => click('迁移工作目录…'))
    await act(async () => click('确认迁移'))
    expect(container!.textContent).toContain('有任务正在运行')
    expect(container!.textContent).toContain('D:\\old')
  })
})
