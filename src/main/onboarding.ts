/** First-run onboarding: the marker file that remembers whether the wizard
 *  has been offered (completed or skipped both count — an explicit skip is
 *  the user's decision) and the DeepSeek profile it saves. The existence
 *  check mirrors seedClaudeMemory: an absent or unreadable marker simply
 *  means the wizard has not finished yet. */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { PROVIDER_CATALOG } from '../shared/provider-catalog'
import type { ModelProfile } from '../shared/contracts'

export type OnboardingOutcome = 'completed' | 'skipped'

export interface OnboardingMarker {
  version: 1
  outcome: OnboardingOutcome
  at: string
}

/** The pages the wizard's buttons open — a fixed table, so the renderer never
 *  supplies a URL. */
export const ONBOARDING_PAGES = {
  signup: 'https://platform.deepseek.com/sign_up',
  'api-keys': 'https://platform.deepseek.com/api_keys',
  'top-up': 'https://platform.deepseek.com/top_up'
} as const
export type OnboardingPage = keyof typeof ONBOARDING_PAGES

export function onboardingMarkerPath(dataRoot: string): string {
  return path.join(dataRoot, 'onboarding.json')
}

export function readOnboardingMarker(dataRoot: string): OnboardingMarker | null {
  try {
    const raw = readFileSync(onboardingMarkerPath(dataRoot), 'utf8')
    const value = JSON.parse(raw) as Partial<OnboardingMarker> | null
    if (value && (value.outcome === 'completed' || value.outcome === 'skipped')) {
      return { version: 1, outcome: value.outcome, at: typeof value.at === 'string' ? value.at : '' }
    }
  } catch {
    // Absent or unreadable: not offered yet.
  }
  return null
}

export function writeOnboardingMarker(dataRoot: string, outcome: OnboardingOutcome): void {
  try {
    writeFileSync(
      onboardingMarkerPath(dataRoot),
      JSON.stringify({ version: 1, outcome, at: new Date().toISOString() }),
      'utf8'
    )
  } catch {
    // Best effort — failing to write only means the wizard may offer again.
  }
}

/** Offer the wizard only when nothing says it was already handled and no
 *  model is configured yet (a profile seeded from the launch environment
 *  counts as configured). */
export function shouldOfferOnboarding(marker: OnboardingMarker | null, profileCount: number): boolean {
  return marker === null && profileCount === 0
}

/** The DeepSeek profile the wizard saves, built from the shared vendor
 *  catalog so URL and model ids stay in one place. */
export function deepSeekProfile(apiKey: string, model: string, id?: string): ModelProfile {
  const provider = PROVIDER_CATALOG.find((item) => item.id === 'deepseek')
  if (!provider) throw new Error('厂商目录缺少 DeepSeek。')
  return {
    id: id ?? crypto.randomUUID(),
    name: provider.name,
    baseUrl: provider.baseUrl,
    apiKey,
    model,
    smallModel: provider.smallModel
  }
}

/** The wizard only ever saves a DeepSeek model from the catalog — anything
 *  else coming over IPC is rejected. */
export function deepSeekModel(value: unknown): string | null {
  const provider = PROVIDER_CATALOG.find((item) => item.id === 'deepseek')
  const id = typeof value === 'string' ? value : ''
  return provider?.models.some((item) => item.id === id) ? id : null
}

/** The base URL every DeepSeek profile shares — used to upsert instead of
 *  stacking duplicates when the wizard runs again. */
export function deepSeekBaseUrl(): string {
  const provider = PROVIDER_CATALOG.find((item) => item.id === 'deepseek')
  if (!provider) throw new Error('厂商目录缺少 DeepSeek。')
  return provider.baseUrl
}
