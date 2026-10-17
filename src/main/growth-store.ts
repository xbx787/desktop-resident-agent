import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GrowthProposal } from '../shared/contracts'

interface GrowthFile { version: 1; proposals: GrowthProposal[] }

function validProposal(value: unknown): value is GrowthProposal {
  if (!value || typeof value !== 'object') return false
  const item = value as Record<string, unknown>
  return typeof item.id === 'string' && typeof item.title === 'string' &&
    typeof item.objective === 'string' && typeof item.evidence === 'string' &&
    typeof item.status === 'string' && typeof item.createdAt === 'string' &&
    typeof item.updatedAt === 'string'
}

const STATUS_LABELS: Record<GrowthProposal['status'], string> = {
  proposed: '待同意实验',
  running: '实验中',
  ready: '待审阅',
  failed: '实验失败',
  stale: '源码已变化',
  adopted: '已在本机采纳',
  published: '已发布 GitHub',
  discarded: '已丢弃'
}

/** 成长建议的本地可读副本：用户不通过设置界面看，而是直接翻这个 MD。 */
function growthMarkdown(file: GrowthFile): string {
  const lines = [
    '# 成长建议（本地）',
    '',
    '> 这些建议只保存在本机，不出现在设置界面，也不会随仓库或发布包分发。',
    '> 处理完一条后可以直接在这里删掉，或保留作记录。',
    ''
  ]
  for (const item of file.proposals) {
    lines.push(
      `## ${item.title}`,
      '',
      `- 状态：${STATUS_LABELS[item.status] ?? item.status}`,
      `- 创建：${item.createdAt}`,
      `- 更新：${item.updatedAt}`,
      '',
      '**目标**',
      '',
      item.objective,
      '',
      '**依据**',
      '',
      item.evidence,
      ''
    )
    if (item.error) lines.push('**错误**', '', item.error, '')
    if (item.releaseNotes) lines.push('**版本说明**', '', item.releaseNotes, '')
  }
  return lines.join('\n') + '\n'
}

/** The store contains review metadata only. Worktrees and packages stay under data/. */
export class GrowthStore {
  readonly filePath: string
  private queue: Promise<void> = Promise.resolve()

  constructor(dataRoot: string) {
    this.filePath = path.join(dataRoot, 'growth', 'proposals.json')
  }

  private async read(): Promise<GrowthFile> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!value || typeof value !== 'object' || (value as GrowthFile).version !== 1 ||
        !Array.isArray((value as GrowthFile).proposals) || !(value as GrowthFile).proposals.every(validProposal)) {
        throw new Error('成长提案文件格式无效，原文件已保留。')
      }
      return value as GrowthFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, proposals: [] }
      throw error
    }
  }

  private async write(file: GrowthFile): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temporary = path.join(path.dirname(this.filePath), `.proposals.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, 'wx')
      try {
        await handle.writeFile(JSON.stringify(file, null, 2) + '\n', 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await fs.rename(temporary, this.filePath)
      await fs.writeFile(path.join(path.dirname(this.filePath), 'proposals.md'), growthMarkdown(file), 'utf8')
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async list(): Promise<GrowthProposal[]> {
    await this.queue
    return (await this.read()).proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async get(id: string): Promise<GrowthProposal> {
    const found = (await this.list()).find((item) => item.id === id)
    if (!found) throw new Error('成长提案不存在。')
    return found
  }

  private async change<T>(fn: (file: GrowthFile) => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const file = await this.read()
      const result = fn(file)
      await this.write(file)
      return result
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async propose(title: string, objective: string, evidence: string, sourceConversationId?: string): Promise<GrowthProposal> {
    const clean = (value: string, limit: number): string => value.trim().slice(0, limit)
    const heading = clean(title, 80)
    const task = clean(objective, 2_000)
    const basis = clean(evidence, 2_000)
    if (!heading || !task || !basis) throw new Error('请填写改进目标与发现依据。')
    return this.change((file) => {
      const existing = file.proposals.find((item) => item.status !== 'discarded' &&
        item.objective === task && item.sourceConversationId === sourceConversationId)
      if (existing) return existing
      const now = new Date().toISOString()
      const proposal: GrowthProposal = {
        id: randomUUID(), title: heading, objective: task, evidence: basis,
        ...(sourceConversationId ? { sourceConversationId } : {}),
        status: 'proposed', createdAt: now, updatedAt: now
      }
      file.proposals.push(proposal)
      return proposal
    })
  }

  async update(id: string, patch: Partial<GrowthProposal>): Promise<GrowthProposal> {
    return this.change((file) => {
      const item = file.proposals.find((entry) => entry.id === id)
      if (!item) throw new Error('成长提案不存在。')
      Object.assign(item, patch, { id, updatedAt: new Date().toISOString() })
      return structuredClone(item)
    })
  }
}
