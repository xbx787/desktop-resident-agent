import { contextBridge, ipcRenderer } from 'electron'
import type { OnboardingOutcome, OnboardingPage } from '../main/onboarding'

/** The wizard's narrow bridge: it can test one DeepSeek key, save that one
 *  profile, open the fixed guide pages, and record how it ended — nothing
 *  else. API keys travel one way (into main) and never come back. */
export interface OnboardingAPI {
  test(apiKey: string, model: string): Promise<{ ok: boolean; message: string }>
  save(apiKey: string, model: string): Promise<void>
  /** The directory the wizard should start from (the current auto choice). */
  defaultWorkspace(): Promise<string>
  /** Native folder picker; null when the user cancels. */
  pickWorkspace(): Promise<string | null>
  /** Saves the workspace on its own, independent of the API key. */
  setWorkspace(path: string): Promise<{ path: string }>
  open(page: OnboardingPage): Promise<void>
  finish(outcome: OnboardingOutcome): Promise<void>
}

const api: OnboardingAPI = {
  test: (apiKey, model) => ipcRenderer.invoke('pet:onboarding:test', apiKey, model),
  save: (apiKey, model) => ipcRenderer.invoke('pet:onboarding:save', apiKey, model),
  defaultWorkspace: () => ipcRenderer.invoke('pet:onboarding:workspace'),
  pickWorkspace: () => ipcRenderer.invoke('pet:onboarding:pick-workspace'),
  setWorkspace: (next) => ipcRenderer.invoke('pet:onboarding:set-workspace', next),
  open: (page) => ipcRenderer.invoke('pet:onboarding:open', page),
  finish: (outcome) => ipcRenderer.invoke('pet:onboarding:finish', outcome)
}

ipcRenderer.on('pet:ui-size', (_event, size: unknown) => {
  document.documentElement.dataset.uiSize = size === 'medium' || size === 'large' ? size : 'small'
})

contextBridge.exposeInMainWorld('whaleOnboarding', api)
