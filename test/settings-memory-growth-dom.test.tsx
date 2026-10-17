// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'
import type { SettingsAPI } from '../src/preload/settings'
import type { ConversationSettings, GrowthProposal } from '../src/shared/contracts'
import type { MemoryItem } from '../src/main/memory-service'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settings: ConversationSettings = {
  visibleConversationTabs: 5, autoArchiveAfterDays: 0, goalMaxIterations: 30,
  goalMaxMinutes: 180, memoryEnabled: true, effort: 'max', modelProfiles: [],
  activeModelProfileId: null, enableAutoTitleGeneration: true,
  showMessageTimestamps: true, userName: '主人', assistantName: '小鲸',
  userAvatar: null, assistantAvatar: null, tabOrder: [], uiSize: 'small'
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
    version: async () => '0.0.47', close: async () => {}, setAvatar: async () => {},
    readAvatar: async () => null, saveModelProfile: async () => {},
    deleteModelProfile: async () => {}, testModelProfile: async () => ({ ok: true, message: '' }),
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
  it('saves the goal budget as one validated setting change', async () => {
    const update = vi.fn(async (patch: Partial<ConversationSettings>) => ({ ...settings, ...patch }))
    await mount(bridge({ update }))
    const iterations = container!.querySelector('#goal-iterations') as HTMLInputElement
    const minutes = container!.querySelector('#goal-minutes') as HTMLInputElement
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    await act(async () => {
      setValue.call(iterations, '40')
      iterations.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(minutes, '120')
      minutes.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      container!.querySelector('.settings-budget-row form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(update).toHaveBeenCalledWith({ goalMaxIterations: 40, goalMaxMinutes: 120 })
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

  it('requires separate experiment, adoption and GitHub publish clicks', async () => {
    let current: GrowthProposal = proposal
    const growthExperiment = vi.fn(async () => {
      current = { ...current, status: 'ready', diff: '+ fixed', releaseNotes: '修复重复失败',
        checks: [{ name: 'check', ok: true, output: 'passed' }] }
      return current
    })
    const growthAdopt = vi.fn(async () => { current = { ...current, status: 'adopted', version: '0.0.48' }; return current })
    const growthPublish = vi.fn(async () => { current = { ...current, status: 'published' }; return current })
    await mount(bridge({
      growthStatus: async () => ({ available: true, proposals: [current] }),
      growthExperiment, growthAdopt, growthPublish
    }))
    await act(async () => click('成长'))
    expect(container!.textContent).toContain('同一工具连续失败两次')
    expect(growthExperiment).not.toHaveBeenCalled()
    await act(async () => click('同意实验'))
    expect(growthExperiment).toHaveBeenCalledOnce()
    expect(container!.textContent).toContain('查看源码差异')
    expect(growthAdopt).not.toHaveBeenCalled()
    await act(async () => click('采纳并安装本机版本'))
    expect(growthAdopt).toHaveBeenCalledOnce()
    expect(growthPublish).not.toHaveBeenCalled()
    await act(async () => click('发布 GitHub'))
    expect(growthPublish).toHaveBeenCalledOnce()
  })
})
