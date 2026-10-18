import { existsSync, promises as fsp } from 'node:fs'
import path from 'node:path'
import type { LibraryItem, LibraryKind, LibrarySnapshot } from '../shared/libraries'
import { isLibraryKind } from '../shared/libraries'

interface LibraryIndex {
  version: 1
  items: LibraryItem[]
}

const MAX_FILES = 400
const MAX_FILE_BYTES = 16 * 1024 * 1024
const MAX_DEPTH = 12

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return cleaned.slice(0, 96) || 'item'
}

function safeRelative(value: string): string {
  const trimmed = value.trim().replace(/\\/gu, '/').replace(/^\.\/+/u, '')
  if (!trimmed) return ''
  const normalized = path.posix.normalize(trimmed)
  if (normalized === '.') return ''
  if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new Error('库路径无效。')
  }
  return normalized.replace(/^\.\//u, '')
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

/** Index-backed storage for the three libraries. Installed code lives under
 *  data/libraries/<kind>/<id>; the index only records what is installed. */
export class LibraryStore {
  private readonly root: string
  private readonly file: string
  private installQueue: Promise<unknown>
  private cached: LibraryItem[] | null = null

  constructor(dataRoot: string) {
    this.root = path.join(dataRoot, 'libraries')
    this.file = path.join(this.root, 'index.json')
    this.installQueue = Promise.resolve()
  }

  private async read(): Promise<LibraryItem[]> {
    if (this.cached) return this.cached
    try {
      const parsed = JSON.parse(await fsp.readFile(this.file, 'utf8')) as Partial<LibraryIndex>
      const items = Array.isArray(parsed.items) ? parsed.items.filter(validItem) : []
      this.cached = items
    } catch {
      this.cached = []
    }
    return this.cached
  }

  private async write(items: LibraryItem[]): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true })
    const temporary = `${this.file}.tmp`
    await fsp.writeFile(temporary, JSON.stringify({ version: 1, items } satisfies LibraryIndex, null, 2), 'utf8')
    await fsp.rename(temporary, this.file)
    this.cached = items
  }

  async list(): Promise<LibraryItem[]> {
    return [...await this.read()]
  }

  async snapshot(): Promise<LibrarySnapshot> {
    return { items: await this.list(), busy: false }
  }

  /** Installs one market entry. MCP entries are configuration only; skills
   *  and plugins are fetched from their source repository into the library. */
  install(entry: LibraryItem): Promise<LibraryItem> {
    const job = this.installQueue.then(() => this.installNow(entry))
    this.installQueue = job.catch(() => undefined)
    return job
  }

  private async installNow(entry: LibraryItem): Promise<LibraryItem> {
    if (!validItem(entry)) throw new Error('库条目无效。')
    const items = await this.read()
    const existing = items.find((item) => item.id === entry.id)
    if (existing) return existing

    let installed: LibraryItem = { ...entry, installedAt: new Date().toISOString() }
    if (entry.kind === 'mcp') {
      if (entry.launch?.type !== 'mcp' || (!entry.launch.command && !entry.launch.url)) {
        throw new Error('这个条目没有可直接启动的地址，暂时不能添加。')
      }
      installed = { ...installed, path: undefined }
    } else {
      installed = await this.installFiles(entry)
    }

    await this.write([...items, installed])
    return installed
  }

  private async installFiles(entry: LibraryItem): Promise<LibraryItem> {
    if (!entry.repo) throw new Error('这个条目没有安装地址。')
    const relative = safeRelative(entry.subdir ?? '')
    const name = safeSegment(entry.id)
    const destination = path.join(this.root, entry.kind, name)
    if (!isInside(this.root, destination)) throw new Error('库路径无效。')

    await fsp.rm(destination, { recursive: true, force: true })
    await fsp.mkdir(destination, { recursive: true })
    const received = { files: 0 }

    if (entry.kind === 'skill') {
      // A skill is exposed to the engine as a tiny local plugin so that
      // adding it with @ only loads that skill, not the whole catalog.
      await this.downloadRepoPath(entry.repo, entry.ref, relative, path.join(destination, 'skills', safeSegment(entry.name)), 0, received)
      await fsp.mkdir(path.join(destination, '.claude-plugin'), { recursive: true })
      await fsp.writeFile(path.join(destination, '.claude-plugin', 'plugin.json'), JSON.stringify({
        name: safeSegment(entry.name),
        description: entry.description || entry.name,
        version: entry.version || undefined
      }, null, 2), 'utf8')
    } else {
      await this.downloadRepoPath(entry.repo, entry.ref, relative, destination, 0, received)
    }
    return { ...entry, installedAt: new Date().toISOString(), path: destination }
  }

  private async downloadRepoPath(repo: string, ref: string | undefined, relative: string,
    destination: string, depth: number, received: { files: number }): Promise<void> {
    if (depth > MAX_DEPTH) throw new Error('目录层级过深，已停止安装。')
    if (received.files > MAX_FILES) throw new Error('文件过多，已停止安装。')
    const url = new URL(`https://api.github.com/repos/${repo}/contents${relative ? `/${relative}` : ''}`)
    if (ref) url.searchParams.set('ref', ref)
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'whale-companion' },
      signal: AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`下载失败（${response.status}）。检查网络后重试。`)
    const payload: unknown = await response.json()
    const entries = Array.isArray(payload) ? payload : [payload]
    await fsp.mkdir(destination, { recursive: true })
    for (const raw of entries) {
      const item = raw as Record<string, unknown>
      const type = item.type
      const name = typeof item.name === 'string' ? item.name : ''
      if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) continue
      if (type === 'dir') {
        await this.downloadRepoPath(repo, ref, `${relative}/${name}`.replace(/^\/+/u, ''),
          path.join(destination, name), depth + 1, received)
        continue
      }
      if (type !== 'file') continue
      const downloadUrl = typeof item.download_url === 'string' ? item.download_url : null
      const size = typeof item.size === 'number' ? item.size : 0
      if (!downloadUrl || size > MAX_FILE_BYTES) continue
      received.files += 1
      if (received.files > MAX_FILES) throw new Error('文件过多，已停止安装。')
      const file = await fetch(downloadUrl, { signal: AbortSignal.timeout(20_000) })
      if (!file.ok) throw new Error(`下载文件失败（${file.status}）。`)
      const bytes = Buffer.from(await file.arrayBuffer())
      if (bytes.length > MAX_FILE_BYTES) continue
      await fsp.writeFile(path.join(destination, name), bytes)
    }
  }

  remove(id: string): Promise<void> {
    const job = this.installQueue.then(async () => {
      const items = await this.read()
      const item = items.find((entry) => entry.id === id)
      if (!item) return
      if (item.path && isInside(this.root, item.path)) {
        await fsp.rm(item.path, { recursive: true, force: true })
      }
      await this.write(items.filter((entry) => entry.id !== id))
    })
    this.installQueue = job.catch(() => undefined)
    return job
  }

  /** The launch details for the given ids, split by what the engine expects. */
  async launches(ids: readonly string[]): Promise<{ mcp: LibraryItem[]; plugins: LibraryItem[] }> {
    const wanted = new Set(ids)
    const items = (await this.read()).filter((item) => wanted.has(`${item.kind}:${item.id}`))
    return {
      mcp: items.filter((item) => item.kind === 'mcp' && item.launch?.type === 'mcp'),
      plugins: items.filter((item) => item.kind !== 'mcp' && item.path && existsSync(item.path))
    }
  }
}

function validItem(value: unknown): value is LibraryItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 300 &&
    isLibraryKind(item.kind) && typeof item.name === 'string' && item.name.length > 0 &&
    typeof item.description === 'string' && typeof item.source === 'string'
}

export function libraryId(kind: LibraryKind, sourceId: string): string {
  return `${sourceId}`.trim().slice(0, 300) || kind
}
