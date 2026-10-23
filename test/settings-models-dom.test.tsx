// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import { voiceApiDefaults } from './voice-api-defaults'
import type { ConversationSettings, ModelProfile } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const profiles: ModelProfile[] = [
  { id: 'p1', name: '一号', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-1', model: 'deepseek-flash', enabled: true },
  { id: 'p2', name: '二号', baseUrl: 'https://api.moonshot.cn/anthropic', apiKey: 'sk-2', apiKeyConfigured: true, model: 'Kimi-K3', enabled: true }
]

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30,
  goalMaxMinutes: 180, memoryEnabled: true, effort: 'max', modelProfiles: profiles,
  activeModelProfileId: 'p1', enableAutoTitleGeneration: true,
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
    version: async () => '0.0.107', close: async () => {}, quit: async () => {}, restart: async () => false, setAvatar: async () => {},
    workspace: async () => ({ path: 'D:\\project', saved: false }),
    pickWorkspace: async () => null, migrateWorkspace: async (next) => ({ path: next }),
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
    ...voiceApiDefaults,
    libraries: async () => ({ items: [], busy: false }),
    searchLibraryMarket: async () => [], installLibrary: async () => ({ items: [], busy: false }), removeLibrary: async () => ({ items: [], busy: false }),
    memoryList: async () => [], memorySetEnabled: async (enabled) => enabled,
    memoryUpdate: async (id, text) => ({ id, text, sourceConversationId: 'c', sourceAt: '', createdAt: '', updatedAt: '' }),
    memoryDelete: async () => {},
    growthStatus: async () => ({ available: false, proposals: [] }), growthPropose: async () => { throw new Error('unused') },
    growthExperiment: async () => { throw new Error('unused') }, growthAdopt: async () => { throw new Error('unused') },
    growthPublish: async () => { throw new Error('unused') }, growthDiscard: async () => { throw new Error('unused') },
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
  await act(async () => click('模型'))
  await act(async () => { await Promise.resolve() })
}

describe('settings model profiles', () => {
  it('停用非当前配置会调用主进程，当前配置的停用按钮禁用', async () => {
    const setEnabled = vi.fn(async () => {})
    await mount(bridge({ setModelProfileEnabled: setEnabled }))
    const rows = [...container!.querySelectorAll('.settings-row')]
    const second = rows.find((row) => row.textContent?.includes('二号'))!
    const first = rows.find((row) => row.textContent?.includes('一号'))!
    expect([...first.querySelectorAll('button')].find((button) => button.textContent === '停用')?.disabled).toBe(true)
    const disable = [...second.querySelectorAll('button')].find((button) => button.textContent === '停用')!
    await act(async () => disable.click())
    expect(setEnabled).toHaveBeenCalledWith('p2', false)
  })

  it('发现模型后可以用搜索过滤并点选模型 ID', async () => {
    const discover = vi.fn(async () => ({ ok: true, models: ['Kimi-K3', 'Kimi-K2.5'], message: '发现 2 个模型。' }))
    await mount(bridge({ discoverModels: discover }))
    const second = [...container!.querySelectorAll('.settings-row')].find((row) => row.textContent?.includes('二号'))!
    const edit = [...second.querySelectorAll('button')].find((button) => button.textContent === '编辑')!
    await act(async () => edit.click())
    await act(async () => click('发现模型'))
    expect(discover).toHaveBeenCalled()
    expect(container!.textContent).toContain('发现 2 个模型。')
    const search = container!.querySelector<HTMLInputElement>('input[aria-label="搜索已发现的模型"]')!
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setter.call(search, 'K2')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const chips = [...container!.querySelectorAll<HTMLButtonElement>('.settings-model-discovered button')]
    expect(chips.map((chip) => chip.textContent)).toEqual(['Kimi-K2.5'])
    await act(async () => chips[0].click())
    expect(container!.querySelector<HTMLInputElement>('input[placeholder="厂商文档中的模型 ID"]')?.value).toBe('Kimi-K2.5')
  })
})
