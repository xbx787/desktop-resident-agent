import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  GrowthExperiments, experimentFileAllowed, experimentToolAllowed, runGrowthCommand,
  type GrowthCommand
} from '../src/main/growth-experiments'

const cacheRoot = path.join(process.cwd(), '.cache', 'tests')
let root = ''

async function git(args: string[], cwd = root): Promise<string> {
  const result = await runGrowthCommand('git.exe', args, cwd)
  if (result.code !== 0) throw new Error(result.output)
  return result.output.trim()
}

async function repository(): Promise<void> {
  await fs.mkdir(path.join(root, 'src'), { recursive: true })
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(root, '.gitignore'), 'data/\nnode_modules/\nrelease/\n')
  await fs.writeFile(path.join(root, 'src', 'base.txt'), 'base\n')
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"growth-fixture","version":"0.0.46"}\n')
  await fs.writeFile(path.join(root, 'CHANGELOG.md'), '# 更新日志\n')
  await git(['init', '-q'])
  await git(['config', 'user.name', 'Growth Test'])
  await git(['config', 'user.email', 'growth@example.test'])
  await git(['add', '-A'])
  await git(['commit', '-qm', 'base'])
}

beforeEach(async () => {
  await fs.mkdir(cacheRoot, { recursive: true })
  root = path.join(cacheRoot, `growth-${randomUUID()}`)
  await fs.mkdir(root, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(cacheRoot, root)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid growth test cleanup')
  await fs.rm(root, { recursive: true, force: true })
})

describe('growth experiment boundaries', () => {
  it('rejects paths outside worktree and links into protected data, including auto-allowed tool calls', async () => {
    await fs.mkdir(path.join(root, 'data'), { recursive: true })
    await fs.mkdir(path.join(root, 'src'), { recursive: true })
    await fs.writeFile(path.join(root, 'data', 'private.txt'), 'private')
    await fs.symlink(path.join(root, 'data'), path.join(root, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    expect(await experimentFileAllowed(root, 'src/file.ts')).toBe(true)
    expect(await experimentFileAllowed(root, 'package.json')).toBe(false)
    expect(await experimentFileAllowed(root, '../outside.txt')).toBe(false)
    expect(await experimentFileAllowed(root, 'data/private.txt')).toBe(false)
    expect(await experimentFileAllowed(root, 'src/linked/private.txt')).toBe(false)
    expect(await experimentToolAllowed(root, 'Write', { file_path: '../outside.txt' })).toBe(false)
    expect(await experimentToolAllowed(root, 'Glob', { path: 'src', pattern: '../**/*' })).toBe(false)
    expect(await experimentToolAllowed(root, 'Grep', { path: 'src', glob: '**/.env*' })).toBe(false)
    expect(await experimentToolAllowed(root, 'Bash', { command: 'echo unsafe' })).toBe(false)
    expect(await experimentToolAllowed(root, 'Read', { file_path: 'src/file.ts' })).toBe(true)
  })

  it('runs approved source edits in a separate worktree and leaves the main branch unchanged', async () => {
    await repository()
    const original = await git(['rev-parse', 'HEAD'])
    const command: GrowthCommand = async (executable, args, cwd) =>
      executable === 'git.exe' ? runGrowthCommand(executable, args, cwd) : { code: 0, output: 'passed' }
    const growth = new GrowthExperiments({
      projectRoot: root, dataRoot: path.join(root, 'data'), claudeExecutable: 'test-only',
      provider: async () => ({ baseUrl: 'https://example.test', apiKey: 'fixture-secret', model: 'fixture' }),
      command,
      agent: async (worktree) => { await fs.writeFile(path.join(worktree, 'src', 'change.txt'), 'changed\n') }
    })
    const proposed = await growth.propose('Fix change', 'Add a checked change', 'Repeated test failure')
    const ready = await growth.experiment(proposed.id)
    expect(ready.status).toBe('ready')
    expect(ready.checks?.map((check) => check.ok)).toEqual([true, true, true])
    expect(ready.diff).toContain('src/change.txt')
    expect(await git(['rev-parse', 'HEAD'])).toBe(original)
    expect(await fs.stat(path.join(root, 'src', 'change.txt')).then(() => true, () => false)).toBe(false)
    expect(await fs.realpath(path.join(root, 'data', 'experiments', 'worktrees', proposed.id, 'node_modules')))
      .toBe(await fs.realpath(path.join(root, 'node_modules')))
  })

  it('keeps a failed check unadoptable and reports the exact failing stage', async () => {
    await repository()
    const growth = new GrowthExperiments({
      projectRoot: root, dataRoot: path.join(root, 'data'), claudeExecutable: 'test-only',
      provider: async () => ({ baseUrl: 'https://example.test', apiKey: 'fixture-secret',
        extraEnv: 'PRIVATE_TOKEN=another-fixture-secret', model: 'fixture' }),
      command: async (executable, args, cwd) => executable === 'git.exe'
        ? runGrowthCommand(executable, args, cwd)
        : { code: args.join(' ').includes('run test') ? 1 : 0,
          output: 'fixture-secret another-fixture-secret and an unrelated host token' },
      agent: async (worktree) => { await fs.writeFile(path.join(worktree, 'src', 'change.txt'), 'changed\n') }
    })
    const proposal = await growth.propose('Fix check', 'Test behavior', 'Two failed attempts')
    const failed = await growth.experiment(proposal.id)
    expect(failed.status).toBe('failed')
    expect(failed.checks?.map((check) => [check.name, check.ok])).toEqual([
      ['check', true], ['test', false], ['build', true]
    ])
    const persisted = await fs.readFile(growth.store.filePath, 'utf8')
    expect(persisted).not.toContain('fixture-secret')
    expect(persisted).not.toContain('another-fixture-secret')
    expect(persisted).not.toContain('unrelated host token')
    await expect(growth.adopt(proposal.id)).rejects.toThrow('可采纳条件')
  })

  it('rolls back source and tag if shortcut activation fails after a successful candidate build', async () => {
    await repository()
    const original = await git(['rev-parse', 'HEAD'])
    const command: GrowthCommand = async (executable, args, cwd) => {
      if (executable === 'git.exe') return runGrowthCommand(executable, args, cwd)
      const commandText = args.join(' ')
      if (commandText.includes('npm.cmd version')) {
        const manifestPath = path.join(cwd, 'package.json')
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version: string }
        manifest.version = /npm\.cmd version (\d+\.\d+\.\d+)/u.exec(commandText)?.[1] ?? manifest.version
        await fs.writeFile(manifestPath, JSON.stringify(manifest) + '\n')
      }
      if (commandText.includes('pack-release.ps1')) {
        const version = (JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')) as { version: string }).version
        const packaged = path.join(cwd, 'release', `whale-companion-v${version}`, 'win-unpacked')
        await fs.mkdir(packaged, { recursive: true })
        await fs.writeFile(path.join(packaged, 'package.txt'), 'candidate')
      }
      if (commandText.includes('make-release-archive.ps1')) {
        await fs.writeFile(path.join(root, 'release', 'whale-companion-v0.0.47-win-x64.zip'), 'archive')
      }
      if (commandText.includes('switch-shortcuts.ps1')) return { code: 1, output: 'fixture shortcut failure' }
      return { code: 0, output: 'passed' }
    }
    const growth = new GrowthExperiments({
      projectRoot: root, dataRoot: path.join(root, 'data'), claudeExecutable: 'test-only',
      provider: async () => ({ baseUrl: 'https://example.test', apiKey: 'fixture-secret', model: 'fixture' }),
      command,
      agent: async (worktree) => { await fs.writeFile(path.join(worktree, 'src', 'change.txt'), 'changed\n') }
    })
    const proposal = await growth.propose('Fix rollback', 'Check rollback', 'Repeated failure')
    expect((await growth.experiment(proposal.id)).status).toBe('ready')
    await expect(growth.adopt(proposal.id)).rejects.toThrow('powershell.exe 失败')
    expect(await git(['rev-parse', 'HEAD'])).toBe(original)
    expect(await fs.readFile(path.join(root, 'package.json'), 'utf8')).toContain('0.0.46')
    expect((await runGrowthCommand('git.exe', ['show-ref', '--verify', '--quiet', 'refs/tags/v0.0.47'], root)).code).toBe(1)
    expect((await growth.store.get(proposal.id)).status).toBe('ready')
  })
})
