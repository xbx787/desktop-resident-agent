import { safeStorage } from 'electron'
import type { AppSnapshot, ConversationSettings, ModelProfile } from '../shared/contracts'

const PREFIX = 'safe-storage:v1:'

export class SecretProtectionUnavailableError extends Error {
  constructor() { super('Windows 密钥保护暂不可用，原配置未更改。') }
}

/** Injected into ConversationStore so disk behavior can be tested without Electron. */
export interface SecretCodec {
  encrypt(value: string): string
  decrypt(value: string): string
}

export function electronSecretCodec(): SecretCodec {
  const available = (): boolean => process.platform === 'win32' && safeStorage.isEncryptionAvailable()
  return {
    encrypt(value) {
      if (!available()) throw new SecretProtectionUnavailableError()
      return PREFIX + safeStorage.encryptString(value).toString('base64')
    },
    decrypt(value) {
      if (!available()) throw new SecretProtectionUnavailableError()
      return safeStorage.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'))
    }
  }
}

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(PREFIX)
}

export function protectProfiles(profiles: ModelProfile[], codec: SecretCodec): ModelProfile[] {
  return profiles.map((profile) => ({
    ...profile,
    apiKey: profile.apiKey ? codec.encrypt(profile.apiKey) : '',
    ...(profile.extraEnv ? { extraEnv: codec.encrypt(profile.extraEnv) } : { extraEnv: undefined })
  }))
}

export function restoreProfiles(profiles: ModelProfile[], codec: SecretCodec): { profiles: ModelProfile[]; changed: boolean } {
  let changed = false
  return {
    profiles: profiles.map((profile) => {
      const next = { ...profile }
      let unavailable = false
      for (const field of ['apiKey', 'extraEnv'] as const) {
        const value = next[field]
        if (!value) continue
        if (!isEncryptedSecret(value)) {
          changed = true // Legacy plaintext must be rewritten atomically.
          continue
        }
        try {
          next[field] = codec.decrypt(value)
        } catch (error) {
          if (error instanceof SecretProtectionUnavailableError) throw error
          next[field] = ''
          unavailable = true
          changed = true
        }
      }
      if (unavailable) next.needsKeyReentry = true
      return next
    }),
    changed
  }
}

/** A renderer may know whether credentials exist, but never receive them. */
export function publicProfile(profile: ModelProfile): ModelProfile {
  return {
    id: profile.id,
    name: profile.name,
    baseUrl: profile.baseUrl,
    model: profile.model,
    ...(profile.smallModel === undefined ? {} : { smallModel: profile.smallModel }),
    apiKey: '',
    apiKeyConfigured: Boolean(profile.apiKey),
    extraEnvConfigured: Boolean(profile.extraEnv),
    needsKeyReentry: Boolean(profile.needsKeyReentry)
  }
}

export function publicSettings(settings: ConversationSettings): ConversationSettings {
  return { ...settings, modelProfiles: settings.modelProfiles.map(publicProfile) }
}

export function publicSnapshot<T extends AppSnapshot & { conversationLibrary: NonNullable<AppSnapshot['conversationLibrary']> }>(snapshot: T): T {
  return {
    ...snapshot,
    conversationLibrary: {
      ...snapshot.conversationLibrary,
      settings: publicSettings(snapshot.conversationLibrary.settings)
    }
  } as T
}
