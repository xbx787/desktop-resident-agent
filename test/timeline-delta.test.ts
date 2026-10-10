import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import type { ModelClient } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'
import { applyTimelineDelta } from '../src/renderer/pet-state'
import type { TimelineEntry } from '../src/shared/contracts'

const projectRoot = process.cwd()
let testRoot: string

beforeEach(async () => {
  testRoot = path.resolve(projectRoot, '.cache', 'tests', randomUUID())
  await fs.mkdir(testRoot, { recursive: true })
})

afterEach(async () => {
  const relative = path.relative(projectRoot, testRoot)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a test directory outside the project.')
  }
  await fs.rm(testRoot, { recursive: true, force: true })
})

function runtimeWith(model?: ModelClient): AgentRuntime {
  return new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
}

describe('timeline deltas', () => {
  it('asks for one full send first, then reports only the entries that changed', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, progress) => {
        progress?.('半', 0)
        progress?.('半半', 0)
        return { text: '好' }
      }
    }
    const runtime = runtimeWith(model)

    // Nothing has been reported to a renderer yet: the first take asks for a
    // full send instead of a delta.
    const first = runtime.takeTimelineDelta()
    expect(first.reset).toBe(true)
    expect(first.entries).toEqual([])

    await runtime.sendMessage('你好')
    const second = runtime.takeTimelineDelta()
    expect(second.reset).toBe(false)
    expect(second.baseRevision).toBe(first.revision)
    expect(second.revision).toBeGreaterThan(first.revision)
    // Upsert semantics: the streamed assistant row arrives once, with its
    // latest text — not once per progress tick.
    expect(second.entries.map((entry) => entry.text)).toEqual(['你好', '好'])
    expect(second.entries.filter((entry) => entry.kind === 'assistant')).toHaveLength(1)

    // A take with nothing in between reports nothing at all.
    const third = runtime.takeTimelineDelta()
    expect(third.entries).toEqual([])
    expect(third.revision).toBe(second.revision)
    expect(third.baseRevision).toBe(second.revision)
  })

  it('re-reports a tool entry when its status lands, without duplicating it', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, _progress, _session, onToolEvent) => {
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'start', input: '{"file_path":"README.md"}' })
        onToolEvent?.({ toolUseId: 'read-1', toolName: 'Read', phase: 'result', output: '文件已读取' })
        return { text: '完成' }
      }
    }
    const runtime = runtimeWith(model)
    runtime.takeTimelineDelta()
    await runtime.sendMessage('读一下')
    const delta = runtime.takeTimelineDelta()
    const tools = delta.entries.filter((entry) => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].tool).toMatchObject({ status: 'done', output: '文件已读取' })
  })

  it('asks for a full send again after restoring a conversation', () => {
    const runtime = runtimeWith()
    runtime.takeTimelineDelta()
    const now = new Date().toISOString()
    runtime.restoreConversation({
      id: 'c1',
      title: '旧对话',
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      pinnedAt: null,
      mode: 'demo',
      taskStatus: 'idle',
      timeline: [{ id: 'e1', time: now, kind: 'user', text: '旧消息' }],
      history: [],
      pendingMessages: [],
      sdkSessionId: null
    })
    const delta = runtime.takeTimelineDelta()
    expect(delta.reset).toBe(true)
    expect(runtime.getSnapshot().timeline.map((entry) => entry.text)).toEqual(['旧消息'])
  })

  it('bumps the revision whenever entries change, and the snapshot carries it', async () => {
    const runtime = runtimeWith()
    const before = runtime.getSnapshot().timelineRevision
    await runtime.sendMessage('记录：delta 版本测试')
    const after = runtime.getSnapshot()
    expect(after.timelineRevision).toBeGreaterThan(before)
    expect(after.timeline.some((entry) => entry.text.includes('delta 版本测试'))).toBe(true)
  })
})

describe('applyTimelineDelta', () => {
  const entry = (id: string, text: string): TimelineEntry => ({ id, time: '2026-10-10T00:00:00.000Z', kind: 'assistant', text })

  it('appends unknown ids in change order and replaces known ids in place', () => {
    const base = [entry('a', '1'), entry('b', '2')]
    const next = applyTimelineDelta(base, [entry('c', '3'), entry('b', '2b')])
    expect(next.map((item) => `${item.id}:${item.text}`)).toEqual(['a:1', 'b:2b', 'c:3'])
    // Untouched rows keep their identity, which is what lets the memoized
    // rows in the panel skip re-rendering on every publish.
    expect(next[0]).toBe(base[0])
    expect(next[1]).not.toBe(base[1])
  })

  it('keeps the previous array when nothing changed', () => {
    const base = [entry('a', '1')]
    expect(applyTimelineDelta(base, [])).toBe(base)
  })

  it('collapses repeated updates of one id to its latest value', () => {
    const base = [entry('a', '1'), entry('b', '半')]
    const next = applyTimelineDelta(base, [entry('b', '半半'), entry('b', '半半半')])
    expect(next).toHaveLength(2)
    expect(next[1].text).toBe('半半半')
  })
})
