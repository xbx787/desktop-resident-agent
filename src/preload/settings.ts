import { contextBridge, ipcRenderer } from 'electron'
import type { ConversationSettings, ModelProfile } from '../shared/contracts'

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
}

const api: SettingsAPI = {
  get: () => ipcRenderer.invoke('pet:settings:get'),
  update: (patch) => ipcRenderer.invoke('pet:settings:update', patch),
  version: () => ipcRenderer.invoke('pet:settings:version'),
  setAvatar: (kind, bytes) => ipcRenderer.invoke('pet:set-avatar', kind, bytes),
  readAvatar: (kind) => ipcRenderer.invoke('pet:read-avatar', kind),
  saveModelProfile: (profile) => ipcRenderer.invoke('pet:save-model-profile', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('pet:delete-model-profile', id),
  testModelProfile: (profile) => ipcRenderer.invoke('pet:test-model-profile', profile)
}

contextBridge.exposeInMainWorld('whaleSettings', api)
