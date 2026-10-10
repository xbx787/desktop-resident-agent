import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findSourceProjectRoot, resolveAgentWorkspace } from '../src/main/workspace-root'

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
})
