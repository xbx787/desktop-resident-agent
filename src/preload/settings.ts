import { contextBridge, ipcRenderer } from 'electron'
import type { ConversationSettings, GrowthProposal, ModelProfile } from '../shared/contracts'
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
  /** Stores an avatar image (PNG/JPEG bytes) for `user` or `assistant`. */
  setAvatar(kind: 'user' | 'assistant', bytes: number[]): Promise<void>
  /** Data URL of the stored avatar, or null when none is set. */
  readAvatar(kind: 'user' | 'assistant'): Promise<string | null>
  /** Creates or updates one model profile; the first one becomes active. */
  saveModelProfile(profile: ModelProfile): Promise<void>
  deleteModelProfile(id: string): Promise<void>
  /** Sends one tiny request to the endpoint and reports what came back. */
  testModelProfile(profile: ModelProfile): Promise<{ ok: boolean; message: string }>
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
  setAvatar: (kind, bytes) => ipcRenderer.invoke('pet:set-avatar', kind, bytes),
  readAvatar: (kind) => ipcRenderer.invoke('pet:read-avatar', kind),
  saveModelProfile: (profile) => ipcRenderer.invoke('pet:save-model-profile', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('pet:delete-model-profile', id),
  testModelProfile: (profile) => ipcRenderer.invoke('pet:test-model-profile', profile),
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
  growthUpdateNotes: (id, notes) => ipcRenderer.invoke('pet:growth:update-notes', id, notes)
}

contextBridge.exposeInMainWorld('whaleSettings', api)
