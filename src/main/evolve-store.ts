/** Persistence for self-evolution tasks.
 *
 *  A task survives an app restart: it names the conversation to resume, the
 *  goal condition to re-arm, and the prompt/command steps that were still
 *  pending. The file is deliberately small and human-readable so a failed
 *  task can be inspected or deleted without touching the conversation store. */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type EvolveStepKind = 'prompt' | 'command'
export type EvolveStepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface EvolveStep {
  id: string
  kind: EvolveStepKind
  text: string
  status: EvolveStepStatus
  createdAt: string
  updatedAt: string
  result?: string
}

export interface EvolveTask {
  version: 1
  id: string
  conversationId: string
  goalCondition?: string
  steps: EvolveStep[]
  restartCount: number
  status: 'active' | 'paused' | 'done' | 'failed'
  note?: string
  createdAt: string
  updatedAt: string
}

export interface EvolveScheduleInput {
  goal?: string
  prompt?: string
  command?: string
  note?: string
}

const MAX_STEPS = 50
const MAX_RESTARTS = 10
const MAX_TEXT = 8_000
const MAX_RESULT = 8_000
const MAX_AUDIT_BYTES = 256 * 1024

function now(): string {
  return new Date().toISOString()
}

function clip(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function validTask(value: unknown): value is EvolveTask {
  if (!value || typeof value !== 'object') return false
  const task = value as Partial<EvolveTask>
  if (task.version !== 1 || typeof task.id !== 'string' || typeof task.conversationId !== 'string') return false
  if (task.status !== 'active' && task.status !== 'paused' && task.status !== 'done' && task.status !== 'failed') return false
  if (typeof task.restartCount !== 'number' || !Number.isFinite(task.restartCount)) return false
  if (!Array.isArray(task.steps) || task.steps.length > MAX_STEPS) return false
  return task.steps.every((step) => {
    if (!step || typeof step !== 'object') return false
    const item = step as Partial<EvolveStep>
    return typeof item.id === 'string' &&
      (item.kind === 'prompt' || item.kind === 'command') &&
      typeof item.text === 'string' &&
      (item.status === 'pending' || item.status === 'running' || item.status === 'done' || item.status === 'failed')
  })
}

export class EvolveStore {
  private readonly directory: string
  private readonly file: string
  private readonly auditFile: string

  constructor(dataRoot: string) {
    this.directory = path.join(dataRoot, 'evolve')
    this.file = path.join(this.directory, 'task.json')
    this.auditFile = path.join(this.directory, 'audit.log')
  }

  load(): EvolveTask | null {
    try {
      if (!existsSync(this.file)) return null
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!validTask(parsed)) {
        this.audit('task-invalid', { file: this.file })
        return null
      }
      return parsed
    } catch (error) {
      this.audit('task-read-failed', { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  save(task: EvolveTask): void {
    mkdirSync(this.directory, { recursive: true })
    task.updatedAt = now()
    const temp = `${this.file}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(task, null, 2), 'utf8')
    renameSync(temp, this.file)
  }

  clear(): void {
    try {
      if (existsSync(this.file)) writeFileSync(this.file, '', 'utf8')
    } catch (error) {
      this.audit('task-clear-failed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Appends one resume step; creates the task on first use. */
  schedule(conversationId: string, input: EvolveScheduleInput): EvolveTask {
    const goal = typeof input.goal === 'string' ? input.goal.trim() : ''
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
    const command = typeof input.command === 'string' ? input.command.trim() : ''
    const note = typeof input.note === 'string' ? input.note.trim() : ''
    if (!goal && !prompt && !command) throw new Error('至少提供 goal、prompt 或 command 之一。')
    if (goal.length > MAX_TEXT || prompt.length > MAX_TEXT || command.length > MAX_TEXT) throw new Error('步骤内容过长。')

    const existing = this.load()
    let task: EvolveTask
    if (existing && existing.status === 'active' && existing.conversationId === conversationId) {
      task = existing
    } else {
      if (existing && existing.status === 'active') throw new Error('另一个对话已有进行中的自我进化任务。')
      task = {
        version: 1,
        id: randomUUID(),
        conversationId,
        steps: [],
        restartCount: 0,
        status: 'active',
        createdAt: now(),
        updatedAt: now()
      }
    }
    if (goal) task.goalCondition = clip(goal, MAX_TEXT)
    if (note) task.note = clip(note, MAX_TEXT)
    const stamp = now()
    if (prompt) task.steps.push({ id: randomUUID(), kind: 'prompt', text: clip(prompt, MAX_TEXT), status: 'pending', createdAt: stamp, updatedAt: stamp })
    if (command) task.steps.push({ id: randomUUID(), kind: 'command', text: clip(command, MAX_TEXT), status: 'pending', createdAt: stamp, updatedAt: stamp })
    if (task.steps.length > MAX_STEPS) task.steps.splice(0, task.steps.length - MAX_STEPS)
    this.save(task)
    this.audit('schedule', { task: task.id, conversationId, goal: Boolean(goal), prompt: Boolean(prompt), command: Boolean(command) })
    return task
  }

  updateStep(stepId: string, patch: Partial<Pick<EvolveStep, 'status' | 'result'>>): EvolveTask | null {
    const task = this.load()
    if (!task) return null
    const step = task.steps.find((item) => item.id === stepId)
    if (!step) return null
    if (patch.status) step.status = patch.status
    if (patch.result !== undefined) step.result = clip(patch.result, MAX_RESULT)
    step.updatedAt = now()
    this.save(task)
    this.audit('step', { task: task.id, step: step.id, kind: step.kind, status: step.status })
    return task
  }

  setStatus(status: EvolveTask['status'], note?: string): EvolveTask | null {
    const task = this.load()
    if (!task) return null
    task.status = status
    if (note !== undefined) task.note = clip(note, MAX_TEXT)
    this.save(task)
    this.audit('task-status', { task: task.id, status })
    return task
  }

  /** One restart per completed batch; returns false when the cap is reached. */
  noteRestart(): boolean {
    const task = this.load()
    if (!task || task.status !== 'active') return false
    if (task.restartCount >= MAX_RESTARTS) {
      task.status = 'failed'
      task.note = `重启次数达到上限（${MAX_RESTARTS}），任务已停止。`
      this.save(task)
      this.audit('restart-limit', { task: task.id })
      return false
    }
    task.restartCount += 1
    this.save(task)
    this.audit('restart', { task: task.id, count: task.restartCount })
    return true
  }

  nextPending(): EvolveStep | null {
    const task = this.load()
    return task ? task.steps.find((step) => step.status === 'pending') ?? null : null
  }

  hasPending(): boolean {
    return this.nextPending() !== null
  }

  audit(event: string, detail: Record<string, unknown>): void {
    try {
      mkdirSync(this.directory, { recursive: true })
      if (existsSync(this.auditFile) && statSync(this.auditFile).size > MAX_AUDIT_BYTES) {
        writeFileSync(this.auditFile, '', 'utf8')
      }
      writeFileSync(this.auditFile, `${JSON.stringify({ at: now(), event, ...detail })}\n`, { encoding: 'utf8', flag: 'a' })
    } catch {
      // Audit is best-effort; never let it break a task.
    }
  }
}
