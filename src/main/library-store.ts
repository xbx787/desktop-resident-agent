import { existsSync, promises as fsp, readFileSync, readdirSync, statSync } from 'node:fs'
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
export interface LibraryEnvironment {
  /** Claude's user directory; defaults to the OS home. */
  homeDir?: string
  /** Active workspace, scanned for a project-level .claude folder. */
  workspace?: string
}

export class LibraryStore {
  private readonly root: string
  private readonly file: string
  private readonly home?: string
  private workspace?: string
  private installQueue: Promise<unknown>
  private cached: LibraryItem[] | null = null

  constructor(dataRoot: string, environment: LibraryEnvironment = {}) {
    this.root = path.join(dataRoot, 'libraries')
    this.file = path.join(this.root, 'index.json')
    // Discovery is opt-in: callers pass the real home, tests stay isolated.
    this.home = environment.homeDir
    this.workspace = environment.workspace
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

  /** Installed entries plus read-only entries found in the Claude config and
   *  plugin directories. The scan runs on every call, so a skill dropped into
   *  a known folder appears the next time the settings page asks. */
  async list(): Promise<LibraryItem[]> {
    const items = [...await this.read()]
    const seen = new Set(items.map((item) => `${item.kind}:${item.id}`))
    for (const item of this.scanExternal()) {
      const key = `${item.kind}:${item.id}`
      if (seen.has(key)) continue
      seen.add(key)
      items.push(item)
    }
    return items
  }

  private scanExternal(): LibraryItem[] {
    if (!this.home) return []
    const plugins = this.scanPlugins()
    return [...this.scanMcp(), ...plugins, ...this.scanSkills(plugins)]
  }

  private scanMcp(): LibraryItem[] {
    if (!this.home) return []
    const files = [
      { file: path.join(this.home, '.claude.json'), source: '~/.claude.json' },
      ...(this.workspace ? [{ file: path.join(this.workspace, '.mcp.json'), source: '项目 .mcp.json' }] : [])
    ]
    const items: LibraryItem[] = []
    for (const { file, source } of files) {
      const servers = readJson(file)?.mcpServers
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue
      for (const [name, raw] of Object.entries(servers as Record<string, unknown>)) {
        if (!raw || typeof raw !== 'object') continue
        const server = raw as Record<string, unknown>
        const url = typeof server.url === 'string' && server.url ? server.url : undefined
        const command = typeof server.command === 'string' && server.command ? server.command : undefined
        if (!url && !command) continue
        const args = Array.isArray(server.args)
          ? server.args.filter((arg): arg is string => typeof arg === 'string') : undefined
        const env = server.env && typeof server.env === 'object' && !Array.isArray(server.env)
          ? Object.keys(server.env as Record<string, unknown>) : undefined
        items.push({
          id: externalId('mcp', `${source}:${name}`),
          kind: 'mcp',
          name,
          description: url ? '已在 Claude 配置中：HTTP MCP 服务器' : '已在 Claude 配置中：stdio MCP 服务器',
          source,
          launch: {
            type: 'mcp',
            ...(url ? { url } : { command: command!, ...(args?.length ? { args } : {}) }),
            ...(env?.length ? { env } : {})
          },
          external: true
        })
      }
    }
    return items
  }

  private scanPlugins(): LibraryItem[] {
    if (!this.home) return []
    const registry = readJson(path.join(this.home, '.claude', 'plugins', 'installed_plugins.json'))
    const plugins = registry?.plugins
    if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return []
    const items: LibraryItem[] = []
    for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
      const install = Array.isArray(value) ? value[0] : value
      if (!install || typeof install !== 'object') continue
      const record = install as Record<string, unknown>
      const installPath = typeof record.installPath === 'string' ? record.installPath : undefined
      if (!installPath || !existsSync(installPath)) continue
      const manifest = readJson(path.join(installPath, '.claude-plugin', 'plugin.json'))
      const [name, marketplace] = key.split('@')
      items.push({
        id: externalId('plugin', key),
        kind: 'plugin',
        name: name || key,
        description: typeof manifest?.description === 'string'
          ? manifest.description.slice(0, 2_000)
          : `已安装的 Claude 插件${marketplace ? `（${marketplace}）` : ''}`,
        source: 'Claude 插件目录',
        ...(typeof record.version === 'string' ? { version: record.version } : {}),
        ...(typeof manifest?.license === 'string' ? { license: manifest.license } : {}),
        ...(typeof manifest?.homepage === 'string' ? { homepage: manifest.homepage } : {}),
        ...(typeof record.installedAt === 'string' ? { installedAt: record.installedAt } : {}),
        path: installPath,
        external: true
      })
    }
    return items
  }

  private scanSkills(plugins: LibraryItem[]): LibraryItem[] {
    const roots: Array<{ dir: string; source: string }> = [
      ...(this.home ? [{ dir: path.join(this.home, '.claude', 'skills'), source: '~/.claude/skills' }] : []),
      { dir: path.join(this.root, '..', 'claude', 'skills'), source: 'Claude 配置目录' },
      ...(this.workspace ? [{ dir: path.join(this.workspace, '.claude', 'skills'), source: '项目 .claude/skills' }] : []),
      ...plugins.filter((plugin) => plugin.path).map((plugin) => ({
        dir: path.join(plugin.path!, 'skills'), source: `插件 ${plugin.name}`
      }))
    ]
    const items: LibraryItem[] = []
    for (const { dir, source } of roots) {
      if (items.length >= 400) break
      let entries: string[]
      try { entries = readdirSync(dir) } catch { continue }
      for (const entry of entries) {
        if (items.length >= 400) break
        const skillDir = path.join(dir, entry)
        const manifest = path.join(skillDir, 'SKILL.md')
        try {
          if (!statSync(skillDir).isDirectory() || !existsSync(manifest)) continue
        } catch { continue }
        const meta = skillMeta(manifest, entry)
        items.push({
          id: externalId('skill', `${source}:${meta.name}`),
          kind: 'skill',
          name: meta.name,
          description: meta.description,
          source,
          path: skillDir,
          external: true
        })
      }
    }
    return items
  }

  async snapshot(): Promise<LibrarySnapshot> {
    return { items: await this.list(), busy: false }
  }

  /** Keeps the project-level .claude scan pointed at the current workspace. */
  setWorkspace(workspace: string): void {
    this.workspace = workspace
  }

  /** 只切换启用状态；外部发现的只读条目不允许改。 */
  async setEnabled(id: string, enabled: boolean): Promise<LibraryItem> {
    const items = await this.read()
    const index = items.findIndex((item) => item.id === id)
    if (index < 0) throw new Error('找不到这个库条目。')
    if (items[index].external) throw new Error('外部发现的条目由 Claude 配置管理，不能在这里停用。')
    const updated: LibraryItem = { ...items[index], disabled: !enabled }
    const next = items.map((item, itemIndex) => itemIndex === index ? updated : item)
    await this.write(next)
    return updated
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
    const items = (await this.read()).filter((item) => wanted.has(`${item.kind}:${item.id}`) && !item.disabled)
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

function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Reads the small YAML frontmatter at the top of a SKILL.md. */
function skillMeta(file: string, fallback: string): { name: string; description: string } {
  try {
    const text = readFileSync(file, 'utf8').slice(0, 16_000)
    const block = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(text)?.[1] ?? ''
    const field = (key: string): string | undefined => {
      const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(block)
      return match?.[1]?.trim().replace(/^["']|["']$/gu, '')
    }
    return {
      name: field('name') || fallback,
      description: (field('description') || '本地技能').slice(0, 2_000)
    }
  } catch {
    return { name: fallback, description: '本地技能' }
  }
}

/** A stable id for a discovered entry. The hash keeps same-named skills from
 *  different folders distinct even when the readable part collapses. */
function externalId(kind: LibraryKind, key: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 0x01000193)
  return `local-${kind}-${safeSegment(key)}-${(hash >>> 0).toString(36)}`
}
