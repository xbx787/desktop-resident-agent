import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from '../src/main/conversation-store'
import { publicSettings, publicSnapshot, type SecretCodec } from '../src/main/secret-storage'
import type { ModelProfile } from '../src/shared/contracts'

const root = path.resolve(process.cwd(), '.cache', 'tests')
const dirs: string[] = []
const profile: ModelProfile = {
  id: 'provider-1', name: 'Provider', baseUrl: 'https://example.test',
  apiKey: 'private-api-key', model: 'model-1', extraEnv: 'OTHER_SECRET=private-value'
}

function codec(salt: string): SecretCodec {
  return {
    encrypt(value) { return `safe-storage:v1:${Buffer.from(`${salt}:${value}`).toString('base64')}` },
    decrypt(value) {
      const decoded = Buffer.from(value.slice('safe-storage:v1:'.length), 'base64').toString()
      if (!decoded.startsWith(`${salt}:`)) throw new Error('wrong user')
      return decoded.slice(salt.length + 1)
    }
  }
}

async function directory(): Promise<string> {
  const dir = path.join(root, `secret-storage-${randomUUID()}`)
  dirs.push(dir)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    if (path.relative(root, dir).startsWith('..')) throw new Error('Invalid cleanup directory')
    await fs.rm(dir, { recursive: true, force: true })
  }
})

describe('model secret storage', () => {
  it('atomically migrates plaintext profiles and keeps credentials available only in the main process', async () => {
    const dir = await directory()
    const legacy = new ConversationStore(dir)
    await legacy.updateSettings({ modelProfiles: [profile], activeModelProfileId: profile.id })
    await legacy.createConversation('Keep this conversation')
    const migrated = new ConversationStore(dir, codec('user-a'))
    const state = await migrated.getState()
    expect(state.settings.modelProfiles[0]?.apiKey).toBe(profile.apiKey)
    expect(state.settings.modelProfiles[0]?.extraEnv).toBe(profile.extraEnv)
    expect(state.conversations).toHaveLength(1)
    const raw = await fs.readFile(migrated.filePath, 'utf8')
    expect(raw).not.toContain(profile.apiKey)
    expect(raw).not.toContain('OTHER_SECRET=private-value')
    const diskProfile = JSON.parse(raw).settings.modelProfiles[0]
    expect(diskProfile.apiKey).toMatch(/^safe-storage:v1:/)
    expect(diskProfile.extraEnv).toMatch(/^safe-storage:v1:/)
    const publicView = publicSettings(state.settings)
    expect(publicView.modelProfiles[0]).toMatchObject({ apiKey: '', apiKeyConfigured: true, extraEnvConfigured: true })
    expect(JSON.stringify(publicView)).not.toContain(profile.apiKey)
    expect(JSON.stringify(publicView)).not.toContain('OTHER_SECRET=private-value')
    const snapshot = publicSnapshot({ conversationLibrary: state } as never)
    expect(JSON.stringify(snapshot)).not.toContain(profile.apiKey)
    const futureSecret = { ...profile, refreshToken: 'future-private-token' }
    expect(JSON.stringify(publicSettings({ ...state.settings, modelProfiles: [futureSecret] })))
      .not.toContain('future-private-token')
  })

  it('clears only credentials that cannot be decrypted on another machine and retains chats', async () => {
    const dir = await directory()
    const original = new ConversationStore(dir, codec('user-a'))
    await original.updateSettings({ modelProfiles: [profile], activeModelProfileId: profile.id })
    await original.createConversation('Conversation survives')
    const moved = new ConversationStore(dir, codec('user-b'))
    const state = await moved.getState()
    expect(state.conversations[0]?.title).toBe('Conversation survives')
    expect(state.settings.modelProfiles[0]).toMatchObject({ apiKey: '', extraEnv: '', needsKeyReentry: true })
    const raw = await fs.readFile(moved.filePath, 'utf8')
    expect(JSON.parse(raw).settings.modelProfiles[0].apiKey).toBe('')
  })

  it('keeps the original file untouched when protection is unavailable during legacy migration', async () => {
    const dir = await directory()
    const legacy = new ConversationStore(dir)
    await legacy.updateSettings({ modelProfiles: [profile] })
    const before = await fs.readFile(legacy.filePath, 'utf8')
    const unavailable = new ConversationStore(dir, {
      encrypt() { throw new Error('encryption unavailable') },
      decrypt() { throw new Error('unreachable') }
    })
    await expect(unavailable.getState()).rejects.toThrow('encryption unavailable')
    expect(await fs.readFile(legacy.filePath, 'utf8')).toBe(before)
  })
})
