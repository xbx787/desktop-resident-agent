import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory()
  } catch {
    return false
  }
}

/** A workspace must be an absolute path to an existing directory. */
export function isUsableWorkspace(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim() !== '' &&
    path.isAbsolute(candidate.trim()) && isDirectory(candidate.trim())
}

export function workspaceSettingsPath(dataRoot: string): string {
  return path.join(dataRoot, 'workspace.json')
}

/** The directory chosen in the wizard. Absent or invalid means "auto". */
export function readSavedWorkspace(dataRoot: string): string | null {
  try {
    const value = JSON.parse(readFileSync(workspaceSettingsPath(dataRoot), 'utf8')) as { workspace?: unknown } | null
    return isUsableWorkspace(value?.workspace) ? path.normalize((value!.workspace as string).trim()) : null
  } catch {
    return null
  }
}

export function writeSavedWorkspace(dataRoot: string, workspace: string): void {
  if (!isUsableWorkspace(workspace)) throw new Error('工作目录必须是存在的绝对路径。')
  writeFileSync(workspaceSettingsPath(dataRoot), JSON.stringify({ workspace: path.normalize(workspace.trim()) }, null, 2), 'utf8')
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
  homeDirectory: string,
  savedWorkspace?: string | null
): string {
  const override = env.DESKTOP_PET_WORKSPACE?.trim()
  if (isUsableWorkspace(override)) return path.normalize(override.trim())
  // The wizard's choice survives a cleared environment variable.
  if (isUsableWorkspace(savedWorkspace)) return path.normalize(savedWorkspace.trim())
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
