import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LibraryStore } from '../src/main/library-store'
import type { LibraryItem } from '../src/shared/libraries'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `library-scan-${randomUUID()}`)
const home = path.join(testRoot, 'home')
const workspace = path.join(testRoot, 'workspace')

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value), 'utf8')
}

async function writeSkill(dir: string, name: string, description: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n# Skill\n`, 'utf8')
}

async function seed(): Promise<{ pluginPath: string }> {
  await writeJson(path.join(home, '.claude.json'), {
    mcpServers: {
      'demo-stdio': { command: 'npx', args: ['-y', 'demo'], env: { TOKEN: 'hidden' } },
      'demo-http': { type: 'http', url: 'https://example.com/mcp' }
    }
  })
  await writeSkill(path.join(home, '.claude', 'skills', 'global-skill'), 'global-skill', '全局技能')
  await writeSkill(path.join(workspace, '.claude', 'skills', 'project-skill'), 'project-skill', '项目技能')

  const pluginPath = path.join(home, '.claude', 'plugins', 'cache', 'market', 'demo-plugin', '1.0.0')
  await writeJson(path.join(pluginPath, '.claude-plugin', 'plugin.json'), {
    name: 'demo-plugin', description: '演示插件', version: '1.0.0'
  })
  await writeSkill(path.join(pluginPath, 'skills', 'plugin-skill'), 'plugin-skill', '插件里的技能')
  await writeJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {
    version: 2,
    plugins: {
      'demo-plugin@market': [{ scope: 'user', installPath: pluginPath, version: '1.0.0', installedAt: '2026-10-01T00:00:00.000Z' }]
    }
  })
  return { pluginPath }
}

describe('LibraryStore discovery', () => {
  it('lists existing MCP servers, plugins and skills from the Claude folders', async () => {
    await seed()
    const store = new LibraryStore(path.join(testRoot, 'data'), { homeDir: home, workspace })
    const items = await store.list()

    const mcp = items.filter((item) => item.kind === 'mcp')
    expect(mcp.map((item) => item.name).sort()).toEqual(['demo-http', 'demo-stdio'])
    expect(mcp.every((item) => item.external === true)).toBe(true)
    expect(mcp.find((item) => item.name === 'demo-stdio')?.launch).toMatchObject({
      type: 'mcp', command: 'npx', args: ['-y', 'demo'], env: ['TOKEN']
    })

    const plugins = items.filter((item) => item.kind === 'plugin')
    expect(plugins).toHaveLength(1)
    expect(plugins[0]).toMatchObject({ name: 'demo-plugin', version: '1.0.0', external: true })
    expect(plugins[0].description).toBe('演示插件')

    const skills = items.filter((item) => item.kind === 'skill')
    expect(skills.map((item) => item.name).sort()).toEqual(['global-skill', 'plugin-skill', 'project-skill'])
    expect(skills.find((item) => item.name === 'plugin-skill')?.source).toBe('插件 demo-plugin')
  })

  it('rescans on every list, so a newly added skill appears without a restart', async () => {
    await seed()
    const store = new LibraryStore(path.join(testRoot, 'data'), { homeDir: home, workspace })
    const before = (await store.list()).filter((item) => item.kind === 'skill')
    await writeSkill(path.join(home, '.claude', 'skills', 'late-skill'), 'late-skill', '后来加入')
    const after = (await store.list()).filter((item) => item.kind === 'skill')
    expect(after.length).toBe(before.length + 1)
    expect(after.some((item) => item.name === 'late-skill')).toBe(true)
  })

  it('keeps installed entries first and never deletes a discovered one', async () => {
    await seed()
    const store = new LibraryStore(path.join(testRoot, 'data'), { homeDir: home, workspace })
    const installed: LibraryItem = {
      id: 'io.github.demo/server', kind: 'mcp', name: 'installed', description: '应用安装', source: 'mcp-registry',
      launch: { type: 'mcp', command: 'npx', args: [] }
    }
    await store.install(installed)
    const items = await store.list()
    expect(items[0].id).toBe(installed.id)
    expect(items[0].external).toBeUndefined()

    const discovered = items.find((item) => item.external)!
    await store.remove(discovered.id)
    expect((await store.list()).some((item) => item.id === discovered.id)).toBe(true)
    expect((await store.list()).some((item) => item.id === installed.id)).toBe(true)
  })

  it('stays empty without an explicit home, keeping tests and previews isolated', async () => {
    await seed()
    const store = new LibraryStore(path.join(testRoot, 'isolated'))
    expect(await store.list()).toEqual([])
  })
})
