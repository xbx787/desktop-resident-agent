import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLAUDE_MEMORY_SEED, seedClaudeMemory } from '../src/main/claude-memory'

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.resolve(projectRoot, '.cache', 'tests', randomUUID())
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a test directory outside the project.')
  }
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('claude memory seed', () => {
  it('writes the starter file on first launch, creating the config dir', async () => {
    const dir = path.join(testRoot, 'claude')
    seedClaudeMemory(dir)
    expect(await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe(CLAUDE_MEMORY_SEED)
  })

  it('never overwrites an existing file — it is the user\'s after the first launch', async () => {
    const dir = path.join(testRoot, 'claude')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '我改过的设定', 'utf8')
    seedClaudeMemory(dir)
    expect(await fs.readFile(path.join(dir, 'CLAUDE.md'), 'utf8')).toBe('我改过的设定')
  })
})
