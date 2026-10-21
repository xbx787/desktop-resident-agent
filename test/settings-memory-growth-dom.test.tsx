// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import { voiceApiDefaults } from './voice-api-defaults'
import type { ConversationSettings, GrowthProposal } from '../src/shared/contracts'
import type { MemoryItem } from '../src/main/memory-service'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30,
  goalMaxMinutes: 180, memoryEnabled: true, effort: 'max', modelProfiles: [],
  activeModelProfileId: null, enableAutoTitleGeneration: true,
  showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}
const memory: MemoryItem = {
  id: 'memory-1', text: '喜欢蓝色界面', sourceConversationId: 'conversation-123',
  sourceAt: '2026-10-12T10:00:00.000Z', createdAt: '2026-10-12T10:00:00.000Z',
  updatedAt: '2026-10-12T10:00:00.000Z'
}
const proposal: GrowthProposal = {
  id: 'proposal-1', title: '修复重复失败', objective: '检查重复失败的原因',
  evidence: '同一工具连续失败两次', status: 'proposed',
  createdAt: '2026-10-12T10:00:00.000Z', updatedAt: '2026-10-12T10:00:00.000Z'
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

async function mount(api: SettingsAPI): Promise<void> {
  Object.defineProperty(window, 'whaleSettings', { configurable: true, value: api })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<SettingsPage />))
}

function bridge(overrides: Partial<SettingsAPI> = {}): SettingsAPI {
  return {
    get: async () => settings, update: async (patch) => ({ ...settings, ...patch }),
    version: async () => '0.0.47', close: async () => {}, quit: async () => {}, restart: async () => false, setAvatar: async () => {},
    workspace: async () => ({ path: 'D:\\project', saved: false }),
    pickWorkspace: async () => null,
    migrateWorkspace: async (next) => ({ path: next }),
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
    ...voiceApiDefaults,
    libraries: async () => ({ items: [], busy: false }),
    searchLibraryMarket: async () => [], installLibrary: async () => ({ items: [], busy: false }),
    removeLibrary: async () => ({ items: [], busy: false }),
    memoryList: async () => [memory], memorySetEnabled: async (enabled) => enabled,
    memoryUpdate: async (id, text) => ({ ...memory, id, text }),
    memoryDelete: async () => {},
    growthStatus: async () => ({ available: true, proposals: [proposal] }),
    growthPropose: async () => proposal, growthExperiment: async () => proposal,
    growthAdopt: async () => proposal, growthPublish: async () => proposal,
    growthDiscard: async () => proposal, growthUpdateNotes: async () => proposal,
    ...overrides
  }
}

describe('SettingsPage memory and growth review', () => {
  it('labels the fixed Live2D preview and lets the user return to the standard illustration', async () => {
    const update = vi.fn(async (patch: Partial<ConversationSettings>) => ({ ...settings, ...patch }))
    await mount(bridge({ update }))
    await act(async () => { await Promise.resolve() })
    await act(async () => click('外观'))
    expect(container!.textContent).toContain('Live2D 技术预览（Arch Chan）')
    expect(container!.textContent).toContain('不是小鲸最终形象')
    expect(container!.textContent).toContain('可随时切回标准插画')
    const renderer = container!.querySelector('#avatar-renderer') as HTMLSelectElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(renderer, 'live2d-preview')
      renderer.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(update).toHaveBeenCalledWith({ avatarRenderer: 'live2d-preview' })
  })

  it('目标模式不再提供轮数或时间上限输入', async () => {
    await mount(bridge({}))
    expect(container!.querySelector('#goal-iterations')).toBeNull()
    expect(container!.querySelector('#goal-minutes')).toBeNull()
  })

  it('loads provenance and only toggles memory after an explicit click', async () => {
    const memorySetEnabled = vi.fn(async (enabled: boolean) => enabled)
    await mount(bridge({ memorySetEnabled }))
    await act(async () => click('记忆'))
    expect(container!.textContent).toContain('喜欢蓝色界面')
    expect(container!.querySelector('.settings-memory-meta code')?.getAttribute('title')).toBe('conversation-123')
    expect(memorySetEnabled).not.toHaveBeenCalled()
    await act(async () => {
      container!.querySelector('#settings-panel-memory [role="switch"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(memorySetEnabled).toHaveBeenCalledWith(false)
  })

  it('keeps the growth review out of the visible settings tabs', async () => {
    // 成长实验只写在本机 data/growth/proposals.md，不再给普通用户一个入口。
    await mount(bridge({ growthStatus: async () => ({ available: true, proposals: [proposal] }) }))
    expect([...container!.querySelectorAll('[role="tab"]')].map((node) => node.textContent)).not.toContain('成长')
    expect(container!.textContent).not.toContain('同一工具连续失败两次')
  })
})
