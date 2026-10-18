import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/library-store'
import type { LibraryItem } from '../src/shared/libraries'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `libraries-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

function mcpEntry(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'io.github.demo/server',
    kind: 'mcp',
    name: 'server',
    description: '演示服务',
    source: 'mcp-registry',
    launch: { type: 'mcp', command: 'npx', args: ['-y', 'demo'], env: [] },
    ...overrides
  }
}

describe('LibraryStore', () => {
  it('installs an MCP entry and keeps it across store instances', async () => {
    const store = new LibraryStore(testRoot)
    const installed = await store.install(mcpEntry())
    expect(installed.installedAt).toBeTruthy()
    expect((await store.list())).toHaveLength(1)

    const reopened = new LibraryStore(testRoot)
    expect(await reopened.list()).toMatchObject([{ id: 'io.github.demo/server', kind: 'mcp' }])
  })

  it('does not install the same entry twice', async () => {
    const store = new LibraryStore(testRoot)
    const first = await store.install(mcpEntry())
    const second = await store.install(mcpEntry({ description: 'changed' }))
    expect(second.description).toBe(first.description)
    expect(await store.list()).toHaveLength(1)
  })

  it('refuses an MCP entry with nothing to launch', async () => {
    const store = new LibraryStore(testRoot)
    await expect(store.install(mcpEntry({ launch: undefined }))).rejects.toThrow('没有可直接启动的地址')
  })

  it('resolves only installed kind:id keys and removes cleanly', async () => {
    const store = new LibraryStore(testRoot)
    await store.install(mcpEntry())
    const resolved = await store.launches(['mcp:io.github.demo/server', 'mcp:missing'])
    expect(resolved.mcp.map((item) => item.id)).toEqual(['io.github.demo/server'])
    expect(resolved.plugins).toEqual([])

    await store.remove('io.github.demo/server')
    expect(await store.list()).toEqual([])
    expect(await store.launches(['mcp:io.github.demo/server'])).toEqual({ mcp: [], plugins: [] })
  })
})
