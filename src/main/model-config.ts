import type { ConversationSettings, ModelProfile } from '../shared/contracts'

export function getEnabledDeepSeekKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env.DESKTOP_PET_ENABLE_DEEPSEEK !== '1') return undefined
  return env.DEEPSEEK_API_KEY?.trim() || undefined
}

/** Balance is an account API: never send another provider's key to DeepSeek. */
function isOfficialDeepSeekProfile(profile: ModelProfile): boolean {
  try {
    return new URL(profile.baseUrl).origin === 'https://api.deepseek.com'
  } catch {
    return false
  }
}

/** Read the live settings for each request so changing profiles takes effect immediately. */
export function getDeepSeekBalanceKey(
  settings: Pick<ConversationSettings, 'activeModelProfileId' | 'modelProfiles'>,
  launchKey?: string
): string | undefined {
  const active = settings.modelProfiles.find((profile) => profile.id === settings.activeModelProfileId)
  if (active && isOfficialDeepSeekProfile(active)) {
    const key = active.apiKey.trim()
    if (key) return key
  }
  const saved = settings.modelProfiles.find((profile) => isOfficialDeepSeekProfile(profile) && profile.apiKey.trim())
  return saved?.apiKey.trim() || launchKey?.trim() || undefined
}
