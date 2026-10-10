import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

function isProjectRoot(candidate: string): boolean {
  const manifest = path.join(candidate, 'package.json')
  if (!existsSync(path.join(candidate, 'README.md'))) return false
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name === 'desktop-resident-agent'
  } catch {
    return false
  }
}

export function resolveAgentWorkspace(
  appDirectory: string,
  packaged: boolean,
  env: NodeJS.ProcessEnv,
  homeDirectory: string
): string {
  const override = env.DESKTOP_PET_WORKSPACE?.trim()
  if (override && path.isAbsolute(override) && isDirectory(override)) return path.normalize(override)
  if (!packaged) return appDirectory

  return findSourceProjectRoot(appDirectory) ?? (isDirectory(homeDirectory) ? homeDirectory : appDirectory)
}

export function findSourceProjectRoot(appDirectory: string): string | undefined {
  let candidate = path.resolve(appDirectory)
  for (let level = 0; level < 8; level += 1) {
    if (isProjectRoot(candidate)) return candidate
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return undefined
}
