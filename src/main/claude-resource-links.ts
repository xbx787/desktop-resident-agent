import { promises as fs } from 'node:fs'
import path from 'node:path'

/** Keep SDK session files in the project while reading existing user Skills and commands in place. */
export async function linkClaudeUserResources(configDir: string, userHome: string): Promise<void> {
  await fs.mkdir(configDir, { recursive: true })
  for (const name of ['skills', 'commands'] as const) {
    const source = path.join(userHome, '.claude', name)
    const destination = path.join(configDir, name)
    try {
      if (!(await fs.stat(source)).isDirectory()) continue
      await fs.lstat(destination).then(() => undefined, async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }
    }
  }
}
