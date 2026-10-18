// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import type { ConversationSettings } from '../src/shared/contracts'
import type { LibraryItem } from '../src/shared/libraries'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30,
  goalMaxMinutes: 180, memoryEnabled: true, effort: 'max', modelProfiles: [],
  activeModelProfileId: null, enableAutoTitleGeneration: true,
  showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small', avatarSize: 'small'
}

const installed: LibraryItem = {
  id: 'io.github.demo/server', kind: 'mcp', name: 'demo-server', description: '已安装的演示服务',
  source: 'mcp-registry', license: 'MIT', installedAt: '2026-10-18T00:00:00.000Z',
  launch: { type: 'mcp', command: 'npx', args: ['-y', 'demo'] }
}

const market: LibraryItem[] = [
  installed,
  { id: 'another', kind: 'mcp', name: 'another-server', description: '市场里的另一项', source: 'mcp-registry', license: 'MIT' }
]

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
  const button = container?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...(container?.querySelectorAll('button') ?? [])].find((node) => node.textContent?.trim() === label)
  if (!button) throw new Error(`找不到按钮：${label}`)
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function bridge(overrides: Partial<SettingsAPI> = {}): SettingsAPI {
  return {
    get: async () => settings, update: async (patch) => ({ ...settings, ...patch }),
    version: async () => '0.0.75', close: async () => {}, setAvatar: async () => {},
    workspace: async () => ({ path: 'D:\\project', saved: false }),
    pickWorkspace: async () => null, migrateWorkspace: async (next) => ({ path: next }),
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
    libraries: async () => ({ items: [installed], busy: false }),
    searchLibraryMarket: async () => market,
    installLibrary: async () => ({ items: [installed], busy: false }),
    removeLibrary: async () => ({ items: [], busy: false }),
    memoryList: async () => [], memorySetEnabled: async (enabled) => enabled,
    memoryUpdate: async (id, text) => ({ id, text, sourceConversationId: 'conversation-1', sourceAt: '2026-10-18T00:00:00.000Z', createdAt: '', updatedAt: '' }),
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
  await act(async () => click('库'))
  await act(async () => { await Promise.resolve() })
}

describe('settings libraries page', () => {
  it('shows the three libraries and the matching market', async () => {
    await mount(bridge())
    for (const label of ['MCP', '技能', '插件']) expect(container!.textContent).toContain(label)
    expect(container!.textContent).toContain('MCP 市场')
    expect(container!.textContent).toContain('已安装的演示服务')
    expect(container!.textContent).toContain('市场里的另一项')
    expect(container!.textContent).toContain('已添加')
  })

  it('switches the market with the library and asks for that kind', async () => {
    const search = vi.fn(async () => market)
    await mount(bridge({ searchLibraryMarket: search }))
    await act(async () => click('技能'))
    await act(async () => { await Promise.resolve() })
    expect(container!.textContent).toContain('技能市场')
    expect(search).toHaveBeenCalledWith('skill', '')
  })

  it('installs a market entry through the bridge', async () => {
    const install = vi.fn(async () => ({ items: [installed], busy: false }))
    await mount(bridge({ installLibrary: install }))
    await act(async () => click('添加'))
    expect(install).toHaveBeenCalledWith(expect.objectContaining({ id: 'another' }))
  })
})
