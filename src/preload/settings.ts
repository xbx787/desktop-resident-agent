import { contextBridge, ipcRenderer } from 'electron'
import type { ConversationSettings, GrowthProposal, ModelProfile, VoiceJobProgress, VoiceSettingsPatch, VoiceSettingsPublic } from '../shared/contracts'
import type { LibraryItem, LibraryKind, LibrarySnapshot } from '../shared/libraries'
import type { MemoryItem } from '../main/memory-service'

export interface GrowthOverview {
  available: boolean
  reason?: string
  proposals: GrowthProposal[]
}

export interface SettingsAPI {
  get(): Promise<ConversationSettings>
  update(patch: Partial<ConversationSettings>): Promise<ConversationSettings>
  version(): Promise<string>
  /** The directory the agent works in, and whether the user chose it. */
  workspace(): Promise<{ path: string; saved: boolean }>
  /** Opens the native folder picker; null when the user cancels. */
  pickWorkspace(): Promise<string | null>
  /** Migrates the workspace; refuses while a task is running. */
  migrateWorkspace(path: string): Promise<{ path: string }>
  /** 设置窗口没有系统边框，标题栏画在页面里——这是它唯一的关闭通道。 */
  close(): Promise<void>
  /** Quits the whole app; the conversation store is already on disk. */
  quit(): Promise<void>
  /** Saves, closes, and launches the same executable again. */
  restart(): Promise<void>
  /** Stores an avatar image (PNG/JPEG bytes) for `user` or `assistant`. */
  setAvatar(kind: 'user' | 'assistant', bytes: number[]): Promise<void>
  /** Data URL of the stored avatar, or null when none is set. */
  readAvatar(kind: 'user' | 'assistant'): Promise<string | null>
  /** Creates or updates one model profile; the first one becomes active. */
  saveModelProfile(profile: ModelProfile): Promise<void>
  deleteModelProfile(id: string): Promise<void>
  /** Sends one tiny request to the endpoint and reports what came back. */
  testModelProfile(profile: ModelProfile): Promise<{ ok: boolean; message: string }>
  voiceGet(): Promise<VoiceSettingsPublic>
  voiceSave(patch: VoiceSettingsPatch): Promise<VoiceSettingsPublic>
  voiceTest(input?: { apiKey?: string; voice?: string; speed?: number }): Promise<{ ok: boolean; message: string }>
  voicePickDocument(): Promise<{ path: string; name: string; size: number } | null>
  voiceConvert(path: string): Promise<{ jobId: string; total: number }>
  voiceCancel(jobId: string): Promise<void>
  voiceOpenOutput(jobId: string): Promise<void>
  voiceOpenAudioRoot(): Promise<void>
  voiceOpenKeyPage(): Promise<void>
  onVoiceJobProgress(callback: (progress: VoiceJobProgress) => void): () => void
  /** Installed entries across the MCP, skill, and plugin libraries. */
  libraries(): Promise<LibrarySnapshot>
  /** Searches the market that matches the library kind. */
  searchLibraryMarket(kind: LibraryKind, query: string): Promise<LibraryItem[]>
  /** Installs one market entry, then returns the refreshed libraries. */
  installLibrary(item: LibraryItem): Promise<LibrarySnapshot>
  removeLibrary(id: string): Promise<LibrarySnapshot>
  memoryList(): Promise<MemoryItem[]>
  memorySetEnabled(enabled: boolean): Promise<boolean>
  memoryUpdate(id: string, text: string): Promise<MemoryItem>
  memoryDelete(id: string): Promise<void>
  growthStatus(): Promise<GrowthOverview>
  growthPropose(title: string, objective: string, evidence: string): Promise<GrowthProposal>
  growthExperiment(id: string): Promise<GrowthProposal>
  growthAdopt(id: string): Promise<GrowthProposal>
  growthPublish(id: string): Promise<GrowthProposal>
  growthDiscard(id: string): Promise<GrowthProposal>
  growthUpdateNotes(id: string, notes: string): Promise<GrowthProposal>
}

const api: SettingsAPI = {
  get: () => ipcRenderer.invoke('pet:settings:get'),
  update: (patch) => ipcRenderer.invoke('pet:settings:update', patch),
  version: () => ipcRenderer.invoke('pet:settings:version'),
  workspace: () => ipcRenderer.invoke('pet:settings:workspace'),
  pickWorkspace: () => ipcRenderer.invoke('pet:settings:pick-workspace'),
  migrateWorkspace: (next) => ipcRenderer.invoke('pet:settings:migrate-workspace', next),
  setAvatar: (kind, bytes) => ipcRenderer.invoke('pet:set-avatar', kind, bytes),
  readAvatar: (kind) => ipcRenderer.invoke('pet:read-avatar', kind),
  saveModelProfile: (profile) => ipcRenderer.invoke('pet:save-model-profile', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('pet:delete-model-profile', id),
  testModelProfile: (profile) => ipcRenderer.invoke('pet:test-model-profile', profile),
  voiceGet: () => ipcRenderer.invoke('pet:settings:voice:get'),
  voiceSave: (patch) => ipcRenderer.invoke('pet:settings:voice:save', patch),
  voiceTest: (input) => ipcRenderer.invoke('pet:settings:voice:test', input),
  voicePickDocument: () => ipcRenderer.invoke('pet:settings:voice:pick-document'),
  voiceConvert: (path) => ipcRenderer.invoke('pet:settings:voice:convert', path),
  voiceCancel: (jobId) => ipcRenderer.invoke('pet:settings:voice:cancel', jobId),
  voiceOpenOutput: (jobId) => ipcRenderer.invoke('pet:settings:voice:open-output', jobId),
  voiceOpenAudioRoot: () => ipcRenderer.invoke('pet:settings:voice:open-audio-root'),
  voiceOpenKeyPage: () => ipcRenderer.invoke('pet:settings:voice:open-key-page'),
  onVoiceJobProgress: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, progress: VoiceJobProgress): void => callback(progress)
    ipcRenderer.on('pet:voice:job-progress', listener)
    return () => ipcRenderer.removeListener('pet:voice:job-progress', listener)
  },
  libraries: () => ipcRenderer.invoke('pet:libraries:list'),
  searchLibraryMarket: (kind, query) => ipcRenderer.invoke('pet:libraries:search', kind, query),
  installLibrary: (item) => ipcRenderer.invoke('pet:libraries:install', item),
  removeLibrary: (id) => ipcRenderer.invoke('pet:libraries:remove', id),
  memoryList: () => ipcRenderer.invoke('pet:memory:list'),
  memorySetEnabled: (enabled) => ipcRenderer.invoke('pet:memory:set-enabled', enabled),
  memoryUpdate: (id, text) => ipcRenderer.invoke('pet:memory:update', id, text),
  memoryDelete: (id) => ipcRenderer.invoke('pet:memory:delete', id),
  growthStatus: () => ipcRenderer.invoke('pet:growth:status'),
  growthPropose: (title, objective, evidence) => ipcRenderer.invoke('pet:growth:propose', title, objective, evidence),
  growthExperiment: (id) => ipcRenderer.invoke('pet:growth:experiment', id),
  growthAdopt: (id) => ipcRenderer.invoke('pet:growth:adopt', id),
  growthPublish: (id) => ipcRenderer.invoke('pet:growth:publish', id),
  growthDiscard: (id) => ipcRenderer.invoke('pet:growth:discard', id),
  growthUpdateNotes: (id, notes) => ipcRenderer.invoke('pet:growth:update-notes', id, notes),
  close: () => ipcRenderer.invoke('pet:settings:close'),
  quit: () => ipcRenderer.invoke('pet:settings:quit'),
  restart: () => ipcRenderer.invoke('pet:settings:restart')
}

// 与 pet preload 相同：字号档只写 <html data-ui-size>，CSS 自己派生。
ipcRenderer.on('pet:ui-size', (_event, size: unknown) => {
  document.documentElement.dataset.uiSize = size === 'medium' || size === 'large' ? size : 'small'
})

contextBridge.exposeInMainWorld('whaleSettings', api)
