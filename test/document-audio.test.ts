import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPlaylist, convertDocumentToAudio, readDocumentForSpeech, sanitizeDocumentName } from '../src/main/document-audio'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `document-audio-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('document audio', () => {
  it('reads a markdown file and removes its markup', async () => {
    const file = path.join(testRoot, 'lesson.md')
    await fs.mkdir(testRoot, { recursive: true })
    await fs.writeFile(file, '# 第一课\n\n这是正文。\n\n```\ncode\n```')
    const document = await readDocumentForSpeech(file)
    expect(document.name).toBe('lesson')
    expect(document.segments.map((segment) => segment.text).join('')).toContain('这是正文')
    expect(document.segments.map((segment) => segment.text).join('')).not.toContain('code')
  })

  it('writes numbered audio, a playlist, and a manifest', async () => {
    const result = await convertDocumentToAudio({
      jobId: 'job-1',
      name: '讲义',
      segments: [{ index: 0, text: '第一段' }, { index: 1, text: '第二段' }],
      audioRoot: testRoot,
      voice: 'claire',
      speed: 1,
      signal: new AbortController().signal,
      synthesize: async (text) => Buffer.from(`audio:${text}`),
      now: new Date('2026-10-18T10:00:00')
    })
    expect(result.status).toBe('completed')
    expect(result.completed).toBe(2)
    expect(await fs.readFile(path.join(result.outputDir, '001.mp3'), 'utf8')).toBe('audio:第一段')
    const playlist = await fs.readFile(result.playlistPath, 'utf8')
    expect(playlist).toContain('#EXTM3U')
    expect(playlist).toContain('001.mp3')
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))
    expect(manifest).toMatchObject({ total: 2, completed: 2, status: 'completed' })
    expect(JSON.stringify(manifest)).not.toContain('第一段')
  })

  it('keeps completed files and marks a cancelled job', async () => {
    const controller = new AbortController()
    let calls = 0
    const result = await convertDocumentToAudio({
      jobId: 'job-2',
      name: '取消',
      segments: [{ index: 0, text: '一' }, { index: 1, text: '二' }],
      audioRoot: testRoot,
      voice: 'claire',
      speed: 1,
      signal: controller.signal,
      synthesize: async () => {
        calls += 1
        if (calls === 2) controller.abort()
        return Buffer.from('audio')
      }
    })
    expect(result.status).toBe('cancelled')
    expect(result.completed).toBe(1)
    const manifest = JSON.parse(await fs.readFile(result.manifestPath, 'utf8'))
    expect(manifest.status).toBe('cancelled')
  })

  it('retries a rate-limited segment twice before failing', async () => {
    let calls = 0
    const result = await convertDocumentToAudio({
      jobId: 'job-3',
      name: '重试',
      segments: [{ index: 0, text: '一' }],
      audioRoot: testRoot,
      voice: 'claire',
      speed: 1,
      signal: new AbortController().signal,
      synthesize: async () => {
        calls += 1
        if (calls < 3) throw new Error('语音合成请求过于频繁，请稍后再试。')
        return Buffer.from('ok')
      }
    })
    expect(result.completed).toBe(1)
    expect(calls).toBe(3)
  })

  it('builds a playable playlist and sanitizes Windows names', () => {
    expect(sanitizeDocumentName('C:\\bad:name?.md')).toBe('bad-name-')
    expect(buildPlaylist([{ index: 1, fileName: '001.mp3' }])).toBe('#EXTM3U\n#EXTINF:-1,第 1 段\n001.mp3\n')
  })
})
