import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSourceProjectRoot, isUsableWorkspace, isWritableWorkspace, readSavedWorkspace, resolveAgentWorkspace, writeSavedWorkspace } from '../src/main/workspace-root'

const testRoot = path.join(process.cwd(), '.cache', 'tests', `workspace-${randomUUID()}`)

afterEach(async () => {
  await fs.rm(testRoot, { recursive: true, force: true })
})

describe('packaged Agent working directory', () => {
  it('uses the source project above a nested preview package, keeping its README reachable', async () => {
    const project = path.join(testRoot, 'project')
    const preview = path.join(project, 'release', 'preview', 'win-unpacked')
    await fs.mkdir(preview, { recursive: true })
    await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'desktop-resident-agent' }))
    await fs.writeFile(path.join(project, 'README.md'), '# project')

    expect(resolveAgentWorkspace(preview, true, {}, testRoot)).toBe(project)
    expect(findSourceProjectRoot(preview)).toBe(project)
  })

  it('honors an existing absolute workspace override', async () => {
    const install = path.join(testRoot, 'install')
    const chosen = path.join(testRoot, 'chosen')
    await fs.mkdir(install, { recursive: true })
    await fs.mkdir(chosen)

    expect(resolveAgentWorkspace(install, true, { DESKTOP_PET_WORKSPACE: chosen }, testRoot)).toBe(chosen)
  })

  it('uses the saved wizard choice when no environment override exists', async () => {
    const install = path.join(testRoot, 'install')
    const saved = path.join(testRoot, 'saved')
    await fs.mkdir(install, { recursive: true })
    await fs.mkdir(saved)

    expect(resolveAgentWorkspace(install, true, {}, testRoot, saved)).toBe(saved)
    // An explicit environment variable still wins over the saved choice.
    const envDir = path.join(testRoot, 'env')
    await fs.mkdir(envDir)
    expect(resolveAgentWorkspace(install, true, { DESKTOP_PET_WORKSPACE: envDir }, testRoot, saved)).toBe(envDir)
  })

  it('persists the workspace and rejects missing or relative paths', async () => {
    const dataRoot = path.join(testRoot, 'data')
    const chosen = path.join(testRoot, 'chosen')
    await fs.mkdir(dataRoot, { recursive: true })
    await fs.mkdir(chosen)

    expect(readSavedWorkspace(dataRoot)).toBeNull()
    writeSavedWorkspace(dataRoot, chosen)
    expect(readSavedWorkspace(dataRoot)).toBe(path.normalize(chosen))

    expect(isUsableWorkspace(chosen)).toBe(true)
    expect(isUsableWorkspace('relative/path')).toBe(false)
    expect(isUsableWorkspace(path.join(testRoot, 'missing'))).toBe(false)
    expect(isWritableWorkspace(chosen)).toBe(true)
    expect(isWritableWorkspace(path.join(testRoot, 'missing'))).toBe(false)
    expect(() => writeSavedWorkspace(dataRoot, path.join(testRoot, 'missing'))).toThrow('工作目录')
  })
})
