import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EvolveStore } from '../src/main/evolve-store'

const roots: string[] = []

function store(): { root: string; evolves: EvolveStore } {
  const root = mkdtempSync(path.join(tmpdir(), 'whale-evolve-'))
  roots.push(root)
  return { root, evolves: new EvolveStore(root) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('EvolveStore', () => {
  it('persists goal, prompt and command steps across a reload', () => {
    const { root, evolves } = store()
    const task = evolves.schedule('conversation-1', {
      goal: '把设置页的滚动修好',
      prompt: '重启后继续检查滚动',
      command: 'npm run build',
      note: '第一轮'
    })
    expect(task.steps.map((step) => step.kind)).toEqual(['prompt', 'command'])
    expect(task.steps.every((step) => step.status === 'pending')).toBe(true)

    const reloaded = new EvolveStore(root).load()
    expect(reloaded?.id).toBe(task.id)
    expect(reloaded?.conversationId).toBe('conversation-1')
    expect(reloaded?.goalCondition).toBe('把设置页的滚动修好')
    expect(reloaded?.steps).toHaveLength(2)
  })

  it('marks steps and enforces the restart cap', () => {
    const { evolves } = store()
    const task = evolves.schedule('conversation-1', { prompt: '继续' })
    const step = task.steps[0]
    expect(evolves.updateStep(step.id, { status: 'running' })?.steps[0].status).toBe('running')
    expect(evolves.updateStep(step.id, { status: 'done', result: 'ok' })?.steps[0].result).toBe('ok')

    for (let index = 0; index < 10; index += 1) expect(evolves.noteRestart()).toBe(true)
    expect(evolves.noteRestart()).toBe(false)
    expect(evolves.load()?.status).toBe('failed')
  })

  it('refuses to mix two active conversations and survives a corrupt file', () => {
    const { root, evolves } = store()
    evolves.schedule('conversation-1', { prompt: '继续' })
    expect(() => evolves.schedule('conversation-2', { prompt: '另一个' })).toThrow()
    writeFileSync(path.join(root, 'evolve', 'task.json'), '{not json', 'utf8')
    expect(evolves.load()).toBeNull()
    expect(readFileSync(path.join(root, 'evolve', 'audit.log'), 'utf8')).toContain('task-read-failed')
  })
})
