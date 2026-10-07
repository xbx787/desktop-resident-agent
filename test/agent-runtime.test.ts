import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AgentRuntime } from '../src/main/agent-runtime'
import type { DialogueLine, ModelClient, ModelReply } from '../src/main/deepseek'
import { NoteStore } from '../src/main/note-store'

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

describe('approved test-note capability', () => {
  it('does not write before approval, then creates and reads back one new file', async () => {
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined)
    await runtime.sendMessage('记录：今天验证桌面智能体的审批流程')
    const proposal = runtime.getSnapshot().proposal
    expect(proposal?.target).toContain(path.join('sandbox', 'notes'))
    await expect(fs.stat(proposal!.target)).rejects.toMatchObject({ code: 'ENOENT' })

    await runtime.approveAction(proposal!.id)
    const finalState = runtime.getSnapshot()
    expect(finalState.taskStatus).toBe('done')
    expect(finalState.proposal).toBeUndefined()
    expect(await fs.readFile(proposal!.target, 'utf8')).toBe(proposal!.content)
  })

  it('does not create a file after rejection or stop', async () => {
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined)
    await runtime.sendMessage('记录：这条应被拒绝')
    const rejected = runtime.getSnapshot().proposal!
    runtime.rejectAction(rejected.id)
    await runtime.approveAction(rejected.id)
    await expect(fs.stat(rejected.target)).rejects.toMatchObject({ code: 'ENOENT' })

    await runtime.sendMessage('记录：这条应被停止')
    const stopped = runtime.getSnapshot().proposal!
    runtime.stop()
    await runtime.approveAction(stopped.id)
    expect(runtime.getSnapshot().taskStatus).toBe('cancelled')
    await expect(fs.stat(stopped.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses overwrite and any caller-supplied path outside the sandbox', async () => {
    const store = new NoteStore(testRoot)
    const draft = store.makeDraft('标题', '内容')
    await store.createAndVerify(draft)
    await expect(store.createAndVerify(draft)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await fs.readFile(draft.target, 'utf8')).toBe(draft.content)

    const outside = path.resolve(testRoot, path.basename(draft.target))
    await expect(store.createAndVerify({ ...draft, target: outside })).rejects.toThrow('写入路径不在测试目录内')
    await expect(fs.stat(outside)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects a notes-directory link that redirects writes elsewhere', async () => {
    const store = new NoteStore(testRoot)
    const sandbox = path.join(testRoot, 'sandbox')
    const outside = path.join(testRoot, 'outside')
    await fs.mkdir(sandbox)
    await fs.mkdir(outside)
    await fs.symlink(outside, path.join(sandbox, 'notes'), 'junction')
    const draft = store.makeDraft('链接测试', '不能写出测试目录')
    await expect(store.createAndVerify(draft)).rejects.toThrow('符号链接')
    expect(await fs.readdir(outside)).toEqual([])
  })
})

describe('task cancellation', () => {
  it('waits for a matching user approval before releasing a Claude Code tool request', async () => {
    let executed = false
    const model: ModelClient = {
      respond: async (_history, signal, _onProgress, onToolApproval) => {
        const allowed = await onToolApproval!({ toolName: 'Bash', input: { command: 'echo approved' } }, signal)
        if (allowed) executed = true
        return { text: allowed ? '已执行' : '已拒绝' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const pending = runtime.sendMessage('执行测试命令')
    const proposal = runtime.getSnapshot().proposal
    expect(proposal?.tool).toBe('claude_tool')
    expect(proposal?.content).toContain('echo approved')
    expect(executed).toBe(false)
    await runtime.approveAction(proposal!.id)
    await pending
    expect(executed).toBe(true)
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('does not release a Claude Code tool after stop', async () => {
    let executed = false
    const model: ModelClient = {
      respond: async (_history, signal, _onProgress, onToolApproval) => {
        executed = await onToolApproval!({ toolName: 'Write', input: { file_path: 'blocked.txt', content: 'blocked' } }, signal)
        return { text: '迟到回复' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    const pending = runtime.sendMessage('写文件')
    const proposal = runtime.getSnapshot().proposal
    expect(proposal?.tool).toBe('claude_tool')
    runtime.stop()
    await runtime.approveAction(proposal!.id)
    await pending
    expect(executed).toBe(false)
    expect(runtime.getSnapshot().taskStatus).toBe('cancelled')
  })

  it('updates one assistant entry as Claude Code streams text', async () => {
    const model: ModelClient = {
      respond: async (_history, _signal, onProgress) => {
        onProgress?.('你')
        onProgress?.('你好')
        return { text: '你好' }
      }
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), undefined, undefined, model)
    await runtime.sendMessage('打个招呼')
    const assistantEntries = runtime.getSnapshot().timeline.filter((entry) => entry.kind === 'assistant')
    expect(assistantEntries).toHaveLength(1)
    expect(assistantEntries[0].text).toBe('你好')
    expect(runtime.getSnapshot().taskStatus).toBe('done')
  })

  it('discards a model reply that arrives after stop', async () => {
    let complete!: (reply: ModelReply) => void
    const model: ModelClient = {
      respond: (_history: DialogueLine[], _signal: AbortSignal) =>
        new Promise<ModelReply>((resolve) => {
          complete = resolve
        })
    }
    const runtime = new AgentRuntime(new NoteStore(testRoot), model)
    const pending = runtime.sendMessage('请创建笔记')
    runtime.stop()
    complete({ text: '准备写入', note: { title: '迟到', content: '不应出现' } })
    await pending
    expect(runtime.getSnapshot().taskStatus).toBe('cancelled')
    expect(runtime.getSnapshot().proposal).toBeUndefined()
  })
})
