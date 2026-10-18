// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import type { ConversationSettings } from '../src/shared/contracts'
import { defaultVoiceSettings, voiceApiDefaults } from './voice-api-defaults'

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
    version: async () => '0.0.78', close: async () => {}, quit: async () => {}, restart: async () => {}, setAvatar: async () => {},
    workspace: async () => ({ path: 'D:\\project', saved: false }),
    pickWorkspace: async () => null, migrateWorkspace: async (next) => ({ path: next }),
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
    ...voiceApiDefaults,
    libraries: async () => ({ items: [], busy: false }),
    searchLibraryMarket: async () => [], installLibrary: async () => ({ items: [], busy: false }),
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
  await act(async () => click('语音'))
  await act(async () => { await Promise.resolve() })
}

describe('settings voice page', () => {
  it('shows the key form and the document-to-audio section', async () => {
    await mount(bridge())
    expect(container!.textContent).toContain('SiliconFlow API Key')
    expect(container!.textContent).toContain('测试连接')
    expect(container!.textContent).toContain('文档转音频')
    expect(container!.textContent).toContain('温柔女声')
    expect(container!.querySelector('input[type="password"]')).not.toBeNull()
  })

  it('saves a typed key through the bridge', async () => {
    const save = vi.fn(async () => defaultVoiceSettings)
    await mount(bridge({ voiceSave: save }))
    const input = container!.querySelector<HTMLInputElement>('input[type="password"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sk-test')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => click('保存 Key'))
    expect(save).toHaveBeenCalledWith({ apiKey: 'sk-test' })
  })

  it('tests the connection without a saved key', async () => {
    const test = vi.fn(async () => ({ ok: true, message: '连接成功，语音合成可用。' }))
    await mount(bridge({ voiceTest: test }))
    await act(async () => click('测试连接'))
    expect(test).toHaveBeenCalledTimes(1)
    expect(container!.textContent).toContain('连接成功')
  })

  it('picks a document and starts conversion', async () => {
    const convert = vi.fn(async () => ({ jobId: 'job-1', total: 3 }))
    await mount(bridge({
      voicePickDocument: async () => ({ path: 'D:\\docs\\lesson.md', name: 'lesson.md', size: 1024 }),
      voiceConvert: convert
    }))
    await act(async () => click('选择文档'))
    expect(container!.textContent).toContain('lesson.md')
    await act(async () => click('生成音频'))
    expect(convert).toHaveBeenCalledWith('D:\\docs\\lesson.md')
  })
})
