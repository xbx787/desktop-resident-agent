import type { LibraryItem, LibraryKind } from '../shared/libraries'

interface CacheEntry {
  expires: number
  items: LibraryItem[]
}

const CACHE_MS = 5 * 60_000
const cache = new Map<string, CacheEntry>()

const GITHUB_HEADERS = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'whale-companion'
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

async function json(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    headers: { ...GITHUB_HEADERS, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) throw new Error(`市场暂时连不上（${response.status}）。检查网络后重试。`)
  return response.json()
}

function cached(key: string, load: () => Promise<LibraryItem[]>): Promise<LibraryItem[]> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.items)
  return load().then((items) => {
    cache.set(key, { expires: Date.now() + CACHE_MS, items })
    return items
  })
}

function matches(item: LibraryItem, query: string): boolean {
  if (!query) return true
  const haystack = `${item.name} ${item.description} ${item.id}`.toLocaleLowerCase()
  return query.toLocaleLowerCase().split(/\s+/u).every((word) => haystack.includes(word))
}

/** MCP Registry v0. Entries carry either a launchable package (stdio) or a
 *  remote endpoint. Environment values are deliberately not stored. */
function mcpItem(raw: unknown): LibraryItem | null {
  const wrapper = record(raw)
  const server = record(wrapper?.server) ?? wrapper
  if (!server) return null
  const name = text(server.name)
  if (!name) return null
  const description = text(server.description)
  const version = text(server.version) || undefined
  const repository = record(server.repository)
  const homepage = text(repository?.url) || text(server.websiteUrl) || undefined
  const packages = array(server.packages).map(record).filter(Boolean) as Record<string, unknown>[]
  const remotes = array(server.remotes).map(record).filter(Boolean) as Record<string, unknown>[]
  const displayed = name.split('/').pop() ?? name

  for (const pkg of packages) {
    const transport = record(pkg.transport)
    if (transport && text(transport.type) !== 'stdio') continue
    const registryType = text(pkg.registryType)
    const identifier = text(pkg.identifier)
    if (!identifier) continue
    const env = array(pkg.environmentVariables).map((entry) => text(record(entry)?.name)).filter(Boolean)
    const versionText = text(pkg.version)
    const pinned = versionText ? `${identifier}@${versionText}` : identifier
    const launch = registryType === 'npm'
      ? { type: 'mcp' as const, command: 'npx', args: ['-y', pinned], env }
      : registryType === 'pypi'
        ? { type: 'mcp' as const, command: 'uvx', args: [pinned], env }
        : registryType === 'oci'
          ? { type: 'mcp' as const, command: 'docker', args: ['run', '-i', '--rm', pinned], env }
          : null
    if (!launch) continue
    return {
      id: name, kind: 'mcp', name: displayed, description, version, homepage,
      source: 'mcp-registry', license: text(pkg.license) || undefined, launch
    }
  }

  for (const remote of remotes) {
    const url = text(remote.url)
    if (!url) continue
    return {
      id: name, kind: 'mcp', name: displayed, description, version, homepage,
      source: 'mcp-registry', license: text(remote.license) || undefined,
      launch: { type: 'mcp', url }
    }
  }
  return null
}

async function searchMcp(query: string): Promise<LibraryItem[]> {
  return cached('mcp', async () => {
    const url = new URL('https://registry.modelcontextprotocol.io/v0/servers')
    url.searchParams.set('limit', '100')
    const payload = record(await json(url.toString()))
    return array(payload?.servers).map(mcpItem).filter((item): item is LibraryItem => item !== null)
  }).then((items) => items.filter((item) => matches(item, query)))
}

/** The skill catalog is a repository of one directory per skill. The list is
 *  cached; installation fetches only the chosen directory. */
async function searchSkills(query: string): Promise<LibraryItem[]> {
  return cached('skill', async () => {
    const payload = await json('https://api.github.com/repos/anthropics/skills/contents/skills')
    return array(payload).flatMap((raw): LibraryItem[] => {
      const entry = record(raw)
      const name = text(entry?.name)
      if (!name || text(entry?.type) !== 'dir') return []
      const sourceAvailable = ['docx', 'pdf', 'pptx', 'xlsx'].includes(name)
      return [{
        id: `anthropics/${name}`,
        kind: 'skill',
        name,
        description: sourceAvailable ? '文档处理技能，仅从来源仓库安装。' : '技能目录中的技能。',
        source: 'skill-catalog',
        license: sourceAvailable ? 'source-available' : 'Apache-2.0',
        repo: 'anthropics/skills',
        ref: 'main',
        subdir: `skills/${name}`
      }]
    })
  }).then((items) => items.filter((item) => matches(item, query)))
}

function pluginSource(value: unknown): { repo?: string; subdir?: string; ref?: string } {
  if (typeof value === 'string') {
    return { repo: 'anthropics/claude-plugins-official', subdir: value.replace(/^\.\//u, '') }
  }
  const source = record(value)
  if (!source) return {}
  const repo = text(source.repo)
  const subdir = text(source.path).replace(/^\.\//u, '')
  return { repo: repo || undefined, subdir: subdir || undefined, ref: text(source.ref) || undefined }
}

async function searchPlugins(query: string): Promise<LibraryItem[]> {
  return cached('plugin', async () => {
    const payload = record(await json('https://raw.githubusercontent.com/anthropics/claude-plugins-official/main/.claude-plugin/marketplace.json'))
    return array(payload?.plugins).flatMap((raw): LibraryItem[] => {
      const entry = record(raw)
      const name = text(entry?.name)
      if (!name) return []
      const location = pluginSource(entry?.source)
      if (!location.repo) return []
      return [{
        id: name,
        kind: 'plugin',
        name,
        description: text(entry?.description),
        version: text(entry?.version) || undefined,
        license: text(entry?.license) || undefined,
        source: 'plugin-catalog',
        repo: location.repo,
        ref: location.ref,
        subdir: location.subdir
      }]
    })
  }).then((items) => items.filter((item) => matches(item, query)))
}

export async function searchMarket(kind: LibraryKind, query: string): Promise<LibraryItem[]> {
  const term = query.trim().slice(0, 120)
  if (kind === 'mcp') return searchMcp(term)
  if (kind === 'skill') return searchSkills(term)
  return searchPlugins(term)
}
