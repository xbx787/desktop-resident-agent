import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { VoiceCache } from '../src/main/voice-cache'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `voice-cache-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('VoiceCache', () => {
  it('keys change with every synthesis input', () => {
    const cache = new VoiceCache(testRoot)
    const base = { model: 'm', voice: 'v', speed: 1, format: 'mp3' as const, text: '你好' }
    const key = cache.keyFor(base)
    expect(key).toMatch(/^[a-f0-9]{64}$/u)
    expect(cache.keyFor({ ...base, text: '你好。' })).not.toBe(key)
    expect(cache.keyFor({ ...base, voice: 'other' })).not.toBe(key)
    expect(cache.keyFor({ ...base, speed: 1.1 })).not.toBe(key)
  })

  it('reads what it writes and treats a missing key as a miss', async () => {
    const cache = new VoiceCache(testRoot)
    const key = cache.keyFor({ model: 'm', voice: 'v', speed: 1, format: 'mp3', text: '缓存' })
    expect(await cache.read(key)).toBeUndefined()
    await cache.write(key, Buffer.from('audio-bytes'))
    expect((await cache.read(key))?.toString()).toBe('audio-bytes')
  })

  it('prunes the oldest files beyond the byte limit', async () => {
    const cache = new VoiceCache(testRoot, { maxBytes: 10 })
    const first = cache.keyFor({ model: 'm', voice: 'v', speed: 1, format: 'mp3', text: 'a' })
    const second = cache.keyFor({ model: 'm', voice: 'v', speed: 1, format: 'mp3', text: 'b' })
    await cache.write(first, Buffer.alloc(8))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await cache.write(second, Buffer.alloc(8))
    await cache.prune()
    const stats = await cache.stats()
    expect(stats.bytes).toBeLessThanOrEqual(10)
    expect(stats.files).toBe(1)
  })
})
