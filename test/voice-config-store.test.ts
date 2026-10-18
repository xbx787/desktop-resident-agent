import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceConfigStore } from '../src/main/voice-config-store'
import type { SecretCodec } from '../src/main/secret-storage'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `voice-config-${randomUUID()}`)

const codec: SecretCodec = {
  encrypt: (value) => `safe-storage:v1:${Buffer.from(value, 'utf8').toString('base64')}`,
  decrypt: (value) => {
    if (!value.startsWith('safe-storage:v1:')) throw new Error('bad ciphertext')
    return Buffer.from(value.slice('safe-storage:v1:'.length), 'base64').toString('utf8')
  }
}

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('VoiceConfigStore', () => {
  it('starts with defaults and no key', async () => {
    const store = new VoiceConfigStore(testRoot, codec, {})
    const view = await store.publicView()
    expect(view.keyConfigured).toBe(false)
    expect(view.voice).toBe('claire')
    expect(view.speed).toBe(1)
    expect(view.autoSpeak).toBe(true)
    expect(view.loadError).toBe(false)
  })

  it('encrypts the key on disk and reads it back', async () => {
    const store = new VoiceConfigStore(testRoot, codec, {})
    await store.save({ apiKey: 'sk-secret-value', voice: 'anna', speed: 1.25, autoSpeak: false })
    const raw = await fs.readFile(path.join(testRoot, 'voice.json'), 'utf8')
    expect(raw).not.toContain('sk-secret-value')
    expect(raw).toContain('safe-storage:v1:')

    const reopened = new VoiceConfigStore(testRoot, codec, {})
    expect(await reopened.apiKey()).toEqual({ key: 'sk-secret-value', source: 'stored' })
    const view = await reopened.publicView()
    expect(view.voice).toBe('anna')
    expect(view.speed).toBe(1.25)
    expect(view.autoSpeak).toBe(false)
  })

  it('reports a cross-device ciphertext instead of crashing', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, 'voice.json'), JSON.stringify({
      version: 1, apiKey: 'safe-storage:v1:AAAA', voice: 'claire', speed: 1, autoSpeak: true
    }))
    const store = new VoiceConfigStore(testRoot, {
      encrypt: codec.encrypt,
      decrypt: () => { throw new Error('different machine') }
    }, {})
    const view = await store.publicView()
    expect(view.needsKeyReentry).toBe(true)
    expect(view.keyConfigured).toBe(false)
  })

  it('keeps defaults and flags corruption', async () => {
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(path.join(testRoot, 'voice.json'), '{not json')
    const store = new VoiceConfigStore(testRoot, codec, {})
    const view = await store.publicView()
    expect(view.loadError).toBe(true)
    expect(view.voice).toBe('claire')
    expect(await fs.readFile(path.join(testRoot, 'voice.json'), 'utf8')).toBe('{not json')
  })

  it('falls back to the environment key and imports it explicitly', async () => {
    const store = new VoiceConfigStore(testRoot, codec, { SILICONFLOW_API_KEY: 'env-key' })
    expect((await store.publicView()).envKeyAvailable).toBe(true)
    expect(await store.apiKey()).toEqual({ key: 'env-key', source: 'env' })
    await store.save({ importEnvKey: true })
    expect(await store.apiKey()).toEqual({ key: 'env-key', source: 'stored' })
  })
})
