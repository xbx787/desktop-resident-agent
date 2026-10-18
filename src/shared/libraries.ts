/** 三个库的固定命名。市场名就是库名加“市场”，不要在这里加别的前缀。 */
export type LibraryKind = 'mcp' | 'skill' | 'plugin'

export const LIBRARY_KINDS: readonly LibraryKind[] = ['mcp', 'skill', 'plugin']

export const LIBRARY_LABELS: Record<LibraryKind, string> = {
  mcp: 'MCP',
  skill: '技能',
  plugin: '插件'
}

export const LIBRARY_MARKET_LABELS: Record<LibraryKind, string> = {
  mcp: 'MCP 市场',
  skill: '技能市场',
  plugin: '插件市场'
}

export function isLibraryKind(value: unknown): value is LibraryKind {
  return value === 'mcp' || value === 'skill' || value === 'plugin'
}

/** How a library entry is started once it is added to a conversation. */
export interface LibraryLaunch {
  type: 'mcp' | 'plugin'
  /** MCP stdio launch, or the local plugin directory after installation. */
  command?: string
  args?: string[]
  url?: string
  /** Environment variable names the server needs; values are never stored. */
  env?: string[]
  path?: string
}

/** One entry in a library. The same shape is used by installed entries and
 *  market results; `installedAt` and `path` only exist after installation. */
export interface LibraryItem {
  id: string
  kind: LibraryKind
  name: string
  description: string
  /** Market or catalog that supplied the entry. */
  source: string
  version?: string
  license?: string
  homepage?: string
  launch?: LibraryLaunch
  /** GitHub location used to install skills and plugins. */
  repo?: string
  ref?: string
  subdir?: string
  installedAt?: string
  path?: string
}

export interface LibrarySnapshot {
  items: LibraryItem[]
  /** A market search or install is running. */
  busy: boolean
  error?: string
}

/** The composer token that adds an installed entry to the current chat.
 *  The colon keeps it distinct from @file and @[session] mentions. */
const LIBRARY_MENTION = /(?<![\p{L}\p{N}_.@])@(mcp|skill|plugin):([^\s@]+)/gu

export function libraryMentionToken(item: Pick<LibraryItem, 'kind' | 'id'>): string {
  return `@${item.kind}:${item.id}`
}

function launchValid(value: unknown): value is LibraryLaunch {
  if (value === undefined) return true
  if (!value || typeof value !== 'object') return false
  const launch = value as Record<string, unknown>
  if (launch.type !== 'mcp' && launch.type !== 'plugin') return false
  if (launch.command !== undefined && typeof launch.command !== 'string') return false
  if (launch.args !== undefined && (!Array.isArray(launch.args) || launch.args.some((arg) => typeof arg !== 'string'))) return false
  if (launch.url !== undefined && typeof launch.url !== 'string') return false
  if (launch.env !== undefined && (!Array.isArray(launch.env) || launch.env.some((name) => typeof name !== 'string'))) return false
  if (launch.path !== undefined && typeof launch.path !== 'string') return false
  return true
}

export function isLibraryItem(value: unknown): value is LibraryItem {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 300 &&
    isLibraryKind(item.kind) && typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 160 &&
    typeof item.description === 'string' && item.description.length <= 2_000 &&
    typeof item.source === 'string' && item.source.length <= 120 &&
    (item.version === undefined || typeof item.version === 'string') &&
    (item.license === undefined || typeof item.license === 'string') &&
    (item.homepage === undefined || typeof item.homepage === 'string') &&
    (item.repo === undefined || (typeof item.repo === 'string' && /^[\w.-]+\/[\w.-]+$/u.test(item.repo) &&
      item.repo.split('/').every((segment) => segment !== '.' && segment !== '..'))) &&
    (item.ref === undefined || (typeof item.ref === 'string' && /^[\w./-]+$/u.test(item.ref))) &&
    (item.subdir === undefined || (typeof item.subdir === 'string' && item.subdir.length <= 300 && !item.subdir.includes('..'))) &&
    launchValid(item.launch)
}

export function parseLibraryMentions(text: string): Array<{ kind: LibraryKind; id: string }> {
  const found: Array<{ kind: LibraryKind; id: string }> = []
  const seen = new Set<string>()
  for (const match of text.matchAll(LIBRARY_MENTION)) {
    const kind = match[1] as LibraryKind
    const key = `${kind}:${match[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push({ kind, id: match[2] })
  }
  return found
}
