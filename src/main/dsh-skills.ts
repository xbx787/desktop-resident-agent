/** Mirrors the app's skill and plugin library into the DSH skill roots.
 *
 *  DSH discovers skills at `<DSH_HOME>/skills` (plus project roots). Claude
 *  plugins and skills already live in the app's libraries as directories with
 *  `SKILL.md`; copying their skill bundles there makes them visible to the DSH
 *  `skill` tool without teaching DSH a second plugin format.
 *
 *  The copy is owned by this module: `.pet-managed.json` records exactly which
 *  entries the app wrote, and only those are removed on the next sync. A broken
 *  or half-written library entry never blocks a conversation.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const MANIFEST = '.pet-managed.json'

function safeName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return cleaned.slice(0, 96) || 'skill'
}

function readManifest(root: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(root, MANIFEST), 'utf8'))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function writeManifest(root: string, names: string[]): void {
  try {
    writeFileSync(path.join(root, MANIFEST), JSON.stringify(names, null, 2), 'utf8')
  } catch {
    // A read-only home simply keeps the previous manifest.
  }
}

/** Copies one skill bundle. Returns the directory name on success. */
function copySkill(root: string, source: string, name: string, created: Set<string>): void {
  const target = path.join(root, name)
  try {
    rmSync(target, { recursive: true, force: true })
    cpSync(source, target, { recursive: true, force: true })
    created.add(name)
  } catch {
    // Skip this entry; the next sync retries it.
  }
}

/** Returns the skill directory names currently published to DSH. */
export function syncDshSkills(dshHome: string, libraryPaths: readonly string[]): string[] {
  const root = path.join(dshHome, 'skills')
  try {
    mkdirSync(root, { recursive: true })
  } catch {
    return []
  }
  const previous = readManifest(root)
  const created = new Set<string>()
  for (const raw of libraryPaths) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    const source = path.resolve(raw)
    if (!existsSync(source)) continue
    try {
      if (existsSync(path.join(source, 'SKILL.md'))) {
        copySkill(root, source, safeName(path.basename(source)), created)
        continue
      }
      const skillsDir = path.join(source, 'skills')
      if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) continue
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const skillDir = path.join(skillsDir, entry.name)
        if (!existsSync(path.join(skillDir, 'SKILL.md'))) continue
        copySkill(root, skillDir, safeName(`${path.basename(source)}-${entry.name}`), created)
      }
    } catch {
      // A single unreadable library path is not fatal.
    }
  }
  for (const name of previous) {
    if (created.has(name)) continue
    try { rmSync(path.join(root, name), { recursive: true, force: true }) } catch { /* best effort */ }
  }
  writeManifest(root, [...created])
  return [...created]
}
