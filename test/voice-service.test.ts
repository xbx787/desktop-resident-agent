import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VoiceService } from '../src/main/voice-service'
import type { SecretCodec } from '../src/main/secret-storage'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `voice-service-${randomUUID()}`)

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

function service(overrides: Partial<ConstructorParameters<typeof VoiceService>[0]> = {}) {
  return new VoiceService({
    dataRoot: testRoot,
    codec,
    ...overrides
  })
}

describe('VoiceService', () => {
  it('reports no key until one is saved', async () => {
    const voice = service()
    expect((await voice.getVoiceConfig()).siliconFlowAvailable).toBe(false)
    await expect(voice.transcribe({ bytes: [1], mimeType: 'audio/webm' })).rejects.toThrow('未配置')
  })

  it('synthesizes once and then serves the cached audio', async () => {
    const synthesizeImpl = vi.fn(async () => ({ bytes: Buffer.alloc(256, 1), mimeType: 'audio/mpeg' as const }))
    const voice = service({ synthesizeImpl })
    await voice.saveSettings({ apiKey: 'sk-test' })

    const first = await voice.synthesize({ text: '你好' })
    const second = await voice.synthesize({ text: '你好' })
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(first.audioBase64).toBe(second.audioBase64)
    expect(synthesizeImpl).toHaveBeenCalledTimes(1)
  })

  it('passes the stored key and complete voice name to the client', async () => {
    const synthesizeImpl = vi.fn(async () => ({ bytes: Buffer.alloc(256), mimeType: 'audio/mpeg' as const }))
    const voice = service({ synthesizeImpl })
    await voice.saveSettings({ apiKey: 'sk-test', voice: 'anna', speed: 1.2 })
    await voice.synthesize({ text: '测试' })
    expect(synthesizeImpl).toHaveBeenCalledWith(expect.objectContaining({
      apiKey: 'sk-test',
      voice: 'FunAudioLLM/CosyVoice2-0.5B:anna',
      speed: 1.2
    }))
  })

  it('runs a document job and publishes progress', async () => {
    const progress: string[] = []
    const voice = service({
      synthesizeImpl: async () => ({ bytes: Buffer.alloc(256), mimeType: 'audio/mpeg' }),
      onJobProgress: (event) => progress.push(event.phase)
    })
    await voice.saveSettings({ apiKey: 'sk-test' })
    const file = path.join(testRoot, 'doc.md')
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(file, '第一段。第二段。')

    const job = await voice.startDocumentJob(file)
    expect(job.total).toBeGreaterThan(0)
    await vi.waitFor(() => expect(progress).toContain('done'), { timeout: 5_000 })
    const output = await voice.documentOutputPath(job.jobId)
    const files = await fs.readdir(output)
    expect(files).toContain('playlist.m3u')
    expect(files.some((name) => /^\d{3}\.mp3$/u.test(name))).toBe(true)
  })

  it('does not use the cache for a connection test', async () => {
    const synthesizeImpl = vi.fn(async () => ({ bytes: Buffer.alloc(256), mimeType: 'audio/mpeg' as const }))
    const voice = service({ synthesizeImpl })
    await voice.saveSettings({ apiKey: 'sk-test' })
    await voice.synthesize({ text: '你好，我是小鲸。' })
    const result = await voice.testConnection()
    expect(result.ok).toBe(true)
    expect(synthesizeImpl).toHaveBeenCalledTimes(2)
  })
})
