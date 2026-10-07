import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export interface NoteDraft {
  id: string
  target: string
  content: string
}

/** The only file capability available to the M0 agent. */
export class NoteStore {
  readonly notesDirectory: string

  constructor(projectRoot: string) {
    this.notesDirectory = path.resolve(projectRoot, 'sandbox', 'notes')
  }

  makeDraft(title: string, body: string): NoteDraft {
    const cleanTitle = title.replace(/[\r\n\t]/g, ' ').trim().slice(0, 80) || '测试笔记'
    const cleanBody = body.trim().slice(0, 20_000)
    if (!cleanBody) throw new Error('笔记内容不能为空。')
    const id = randomUUID()
    return {
      id,
      target: path.join(this.notesDirectory, `note-${id}.md`),
      content: `# ${cleanTitle}\n\n${cleanBody}\n`
    }
  }

  async createAndVerify(draft: NoteDraft): Promise<string> {
    if (!/^note-[0-9a-f-]{36}\.md$/i.test(path.basename(draft.target))) {
      throw new Error('文件名不在允许范围内。')
    }
    if (path.resolve(path.dirname(draft.target)) !== this.notesDirectory) {
      throw new Error('写入路径不在测试目录内。')
    }

    await this.ensureSafeDirectory()
    // wx creates a new file exclusively; an existing file is never overwritten.
    await fs.writeFile(draft.target, draft.content, { encoding: 'utf8', flag: 'wx' })
    const actual = await fs.readFile(draft.target, 'utf8')
    if (actual !== draft.content) throw new Error('文件已创建，但读回内容不一致。')
    return draft.target
  }

  private async ensureSafeDirectory(): Promise<void> {
    const sandbox = path.dirname(this.notesDirectory)
    await this.assertNotLink(sandbox)
    await fs.mkdir(sandbox, { recursive: true })
    await this.assertNotLink(sandbox)
    await this.assertNotLink(this.notesDirectory)
    await fs.mkdir(this.notesDirectory, { recursive: true })
    await this.assertNotLink(this.notesDirectory)
    const resolvedSandbox = await fs.realpath(sandbox)
    const resolvedNotes = await fs.realpath(this.notesDirectory)
    if (path.dirname(resolvedNotes) !== resolvedSandbox) {
      throw new Error('测试目录的真实路径异常。')
    }
  }

  private async assertNotLink(target: string): Promise<void> {
    try {
      const stat = await fs.lstat(target)
      if (stat.isSymbolicLink()) throw new Error('测试目录包含符号链接。')
      if (!stat.isDirectory()) throw new Error('测试目录路径不是文件夹。')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
