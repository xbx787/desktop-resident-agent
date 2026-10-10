import { contextBridge, ipcRenderer } from 'electron'
import type { OnboardingOutcome, OnboardingPage } from '../main/onboarding'

/** The wizard's narrow bridge: it can test one DeepSeek key, save that one
 *  profile, open the fixed guide pages, and record how it ended — nothing
 *  else. API keys travel one way (into main) and never come back. */
export interface OnboardingAPI {
  test(apiKey: string, model: string): Promise<{ ok: boolean; message: string }>
  save(apiKey: string, model: string): Promise<void>
  open(page: OnboardingPage): Promise<void>
  finish(outcome: OnboardingOutcome): Promise<void>
}

const api: OnboardingAPI = {
  test: (apiKey, model) => ipcRenderer.invoke('pet:onboarding:test', apiKey, model),
  save: (apiKey, model) => ipcRenderer.invoke('pet:onboarding:save', apiKey, model),
  open: (page) => ipcRenderer.invoke('pet:onboarding:open', page),
  finish: (outcome) => ipcRenderer.invoke('pet:onboarding:finish', outcome)
}

contextBridge.exposeInMainWorld('whaleOnboarding', api)
