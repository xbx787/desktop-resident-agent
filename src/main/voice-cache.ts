import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

export interface VoiceCacheKeyInput {
  model: string
  voice: string
  speed: number
  format: 'mp3'
  text: string
}

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024

/** Content-addressed audio cache. File names are hashes; the text never
 *  reaches disk in a readable form. */
export class VoiceCache {
  private readonly directory: string
  private readonly maxBytes: number
  private lastPrune = 0

  constructor(directory: string, options: { maxBytes?: number } = {}) {
    this.directory = directory
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  }

  keyFor(input: VoiceCacheKeyInput): string {
    const material = ['v1', input.model, input.voice, input.speed.toFixed(2), input.format, input.text].join('\0')
    return createHash('sha256').update(material, 'utf8').digest('hex')
  }

  private filePath(key: string): string {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('语音缓存键无效。')
    return path.join(this.directory, `${key}.mp3`)
  }

  async read(key: string): Promise<Buffer | undefined> {
    try {
      return await fsp.readFile(this.filePath(key))
    } catch {
      return undefined
    }
  }

  async write(key: string, bytes: Buffer): Promise<void> {
    try {
      await fsp.mkdir(this.directory, { recursive: true })
      const target = this.filePath(key)
      const temporary = `${target}.tmp`
      await fsp.writeFile(temporary, bytes)
      await fsp.rename(temporary, target)
      if (Date.now() - this.lastPrune > 60_000) {
        this.lastPrune = Date.now()
        void this.prune().catch(() => undefined)
      }
    } catch {
      // Cache failures must never block playback.
    }
  }

  async prune(): Promise<void> {
    let entries: string[]
    try {
      entries = await fsp.readdir(this.directory)
    } catch {
      return
    }
    const files: Array<{ path: string; size: number; mtime: number }> = []
    for (const name of entries) {
      if (!name.endsWith('.mp3')) continue
      try {
        const info = await fsp.stat(path.join(this.directory, name))
        if (info.isFile()) files.push({ path: path.join(this.directory, name), size: info.size, mtime: info.mtimeMs })
      } catch {
        // A file removed mid-scan is fine.
      }
    }
    let total = files.reduce((sum, file) => sum + file.size, 0)
    if (total <= this.maxBytes) return
    files.sort((a, b) => a.mtime - b.mtime)
    for (const file of files) {
      if (total <= this.maxBytes) break
      try {
        await fsp.rm(file.path, { force: true })
        total -= file.size
      } catch {
        // Best effort.
      }
    }
  }

  async stats(): Promise<{ files: number; bytes: number }> {
    try {
      const entries = await fsp.readdir(this.directory)
      let files = 0
      let bytes = 0
      for (const name of entries) {
        if (!name.endsWith('.mp3')) continue
        try {
          const info = await fsp.stat(path.join(this.directory, name))
          files += 1
          bytes += info.size
        } catch {
          // ignore
        }
      }
      return { files, bytes }
    } catch {
      return { files: 0, bytes: 0 }
    }
  }
}
