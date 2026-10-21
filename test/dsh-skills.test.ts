import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDshSkills } from '../src/main/dsh-skills'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

function skill(dir: string, name: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill\n---\n\nBody.\n`, 'utf8')
}

describe('syncDshSkills', () => {
  it('copies a skill directory and a plugin skill bundle into DSH_HOME/skills', () => {
    const home = temp('whale-dsh-home-')
    const skillDir = path.join(temp('whale-lib-'), 'my-skill')
    skill(skillDir, 'my-skill')
    const pluginDir = path.join(temp('whale-plugin-'), 'my-plugin')
    skill(path.join(pluginDir, 'skills', 'review'), 'review')
    skill(path.join(pluginDir, 'skills', 'write'), 'write')

    const published = syncDshSkills(home, [skillDir, pluginDir])
    expect(published.sort()).toEqual(['my-plugin-review', 'my-plugin-write', 'my-skill'])
    expect(existsSync(path.join(home, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(home, 'skills', 'my-plugin-review', 'SKILL.md'))).toBe(true)

    // A second sync without the plugin removes only the managed copies.
    syncDshSkills(home, [skillDir])
    expect(existsSync(path.join(home, 'skills', 'my-skill'))).toBe(true)
    expect(existsSync(path.join(home, 'skills', 'my-plugin-review'))).toBe(false)
    expect(existsSync(path.join(home, 'skills', 'my-plugin-write'))).toBe(false)
  })

  it('never removes a skill the app did not write', () => {
    const home = temp('whale-dsh-home-')
    const userSkill = path.join(home, 'skills', 'user-made')
    skill(userSkill, 'user-made')
    const skillDir = path.join(temp('whale-lib-'), 'managed')
    skill(skillDir, 'managed')

    syncDshSkills(home, [skillDir])
    syncDshSkills(home, [])
    expect(existsSync(path.join(userSkill, 'SKILL.md'))).toBe(true)
    expect(existsSync(path.join(home, 'skills', 'managed'))).toBe(false)
  })
})
