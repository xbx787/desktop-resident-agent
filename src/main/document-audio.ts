import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { VoiceJobProgress } from '../shared/contracts'
import { segmentForSpeech, type SpeechSegment } from '../shared/speech-text'
import { MAX_DOCUMENT_BYTES, MAX_DOCUMENT_SEGMENTS } from '../shared/voice'

export interface DocumentAudioInput {
  name: string
  segments: SpeechSegment[]
  audioRoot: string
  voice: string
  speed: number
  signal: AbortSignal
  synthesize: (text: string, signal: AbortSignal) => Promise<Buffer>
  onProgress?: (progress: VoiceJobProgress) => void
  jobId: string
  now?: Date
}

export interface DocumentAudioResult {
  outputDir: string
  playlistPath: string
  manifestPath: string
  total: number
  completed: number
  status: 'completed' | 'cancelled'
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/iu

export function sanitizeDocumentName(filePath: string): string {
  const base = path.basename(filePath).replace(/\.[^.]+$/u, '')
  let name = base.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, '-').replace(/[. ]+$/gu, '').trim().slice(0, 60)
  if (!name) name = 'audio'
  if (RESERVED.test(name)) name = `_${name}`
  return name
}

export function buildOutputDirName(name: string, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${name}-${stamp}`
}

export function buildPlaylist(entries: Array<{ index: number; fileName: string; title?: string }>): string {
  const lines = ['#EXTM3U']
  for (const entry of entries) {
    lines.push(`#EXTINF:-1,${entry.title ?? `第 ${entry.index} 段`}`)
    lines.push(entry.fileName)
  }
  return `${lines.join('\n')}\n`
}

function fileNameFor(index: number): string {
  return `${String(index + 1).padStart(3, '0')}.mp3`
}

function retryable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return /频繁|频率|暂时不可用|连接失败|超时/u.test(error.message)
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(new Error('已取消。')); return }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('已取消。'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function synthesizeWithRetry(
  synthesize: DocumentAudioInput['synthesize'], text: string, signal: AbortSignal
): Promise<Buffer> {
  let last: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (signal.aborted) throw new Error('已取消。')
    try {
      return await synthesize(text, signal)
    } catch (error) {
      last = error
      if (!retryable(error) || attempt === 2) break
      await delay(400 * (attempt + 1), signal)
    }
  }
  throw last instanceof Error ? last : new Error('语音合成失败。')
}

async function uniqueDirectory(root: string, base: string): Promise<string> {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const candidate = path.join(root, suffix === 1 ? base : `${base}-${suffix}`)
    try {
      await fsp.access(candidate)
    } catch {
      await fsp.mkdir(candidate, { recursive: true })
      return candidate
    }
  }
  throw new Error('无法创建音频输出目录。')
}

async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  const temporary = `${target}.tmp`
  await fsp.writeFile(temporary, data)
  await fsp.rename(temporary, target)
}

export async function readDocumentForSpeech(filePath: string): Promise<{
  name: string
  bytes: number
  segments: SpeechSegment[]
}> {
  const extension = path.extname(filePath).toLowerCase()
  if (extension !== '.md' && extension !== '.txt') throw new Error('只支持 .md 和 .txt 文档。')
  const info = await fsp.stat(filePath)
  if (!info.isFile()) throw new Error('请选择一个文档文件。')
  if (info.size > MAX_DOCUMENT_BYTES) throw new Error('文档不能超过 2 MB。')
  const raw = await fsp.readFile(filePath, 'utf8')
  const text = raw.replace(/^﻿/u, '')
  const replacement = (text.match(/�/gu) ?? []).length
  if (text && replacement / text.length > 0.01) throw new Error('文档似乎不是 UTF-8 编码，请另存为 UTF-8 后重试。')
  const segments = segmentForSpeech(text)
  if (!segments.length) throw new Error('文档里没有可朗读的文字。')
  if (segments.length > MAX_DOCUMENT_SEGMENTS) throw new Error('文档太长，请拆成几个文件。')
  return { name: sanitizeDocumentName(filePath), bytes: info.size, segments }
}

export async function convertDocumentToAudio(input: DocumentAudioInput): Promise<DocumentAudioResult> {
  const now = input.now ?? new Date()
  await fsp.mkdir(input.audioRoot, { recursive: true })
  const outputDir = await uniqueDirectory(input.audioRoot, buildOutputDirName(input.name, now))
  const playlistEntries: Array<{ index: number; fileName: string; title?: string }> = []
  const manifestFiles: Array<{ index: number; file: string; chars: number }> = []
  let completed = 0
  let cancelled = false

  input.onProgress?.({
    jobId: input.jobId, phase: 'preparing', completed: 0, total: input.segments.length, outputDir
  })

  for (const segment of input.segments) {
    if (input.signal.aborted) { cancelled = true; break }
    try {
      const bytes = await synthesizeWithRetry(input.synthesize, segment.text, input.signal)
      // A cancel during synthesis must not count that segment as finished.
      if (input.signal.aborted) { cancelled = true; break }
      const fileName = fileNameFor(segment.index)
      await writeAtomic(path.join(outputDir, fileName), bytes)
      completed += 1
      playlistEntries.push({ index: segment.index + 1, fileName, title: `第 ${segment.index + 1} 段` })
      manifestFiles.push({ index: segment.index + 1, file: fileName, chars: segment.text.length })
      input.onProgress?.({
        jobId: input.jobId, phase: 'synthesizing', completed, total: input.segments.length, outputDir
      })
    } catch (error) {
      if (input.signal.aborted) { cancelled = true; break }
      throw error
    }
  }

  const playlistPath = path.join(outputDir, 'playlist.m3u')
  const manifestPath = path.join(outputDir, 'manifest.json')
  await writeAtomic(playlistPath, buildPlaylist(playlistEntries))
  await writeAtomic(manifestPath, JSON.stringify({
    version: 1,
    source: input.name,
    createdAt: now.toISOString(),
    voice: input.voice,
    speed: input.speed,
    total: input.segments.length,
    completed,
    status: cancelled ? 'cancelled' : 'completed',
    files: manifestFiles
  }, null, 2))

  input.onProgress?.({
    jobId: input.jobId,
    phase: cancelled ? 'cancelled' : 'done',
    completed,
    total: input.segments.length,
    outputDir
  })

  return {
    outputDir, playlistPath, manifestPath,
    total: input.segments.length, completed,
    status: cancelled ? 'cancelled' : 'completed'
  }
}
