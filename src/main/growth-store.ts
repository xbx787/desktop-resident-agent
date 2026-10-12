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
