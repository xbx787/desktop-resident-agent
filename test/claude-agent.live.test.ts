import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ClaudeAgentClient } from '../src/main/claude-agent'
import { findClaudeExecutable } from '../src/main/claude-code'
import { linkClaudeUserResources } from '../src/main/claude-resource-links'
import { resolveAgentWorkspace } from '../src/main/workspace-root'
import type { AskQuestionRequest, PlanApprovalRequest, TaskUsage } from '../src/shared/contracts'

const runLive = process.env.DESKTOP_PET_LIVE_SDK_TEST === '1'

describe('Claude Agent SDK live tool access', () => {
  it.skipIf(!runLive)('observes a live goal event before interrupting the turn', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, probeDir, path.join(probeDir, 'claude'))
      const events: Array<{ condition: string } | null> = []
      client.setGoalListener((goal) => events.push(goal))
      const turn = client.respond([{ role: 'user', content: '/goal 回答用户提出的下一道简单问题' }], abort.signal).catch(() => undefined)
      const deadline = Date.now() + 25_000
      while (!events.some((goal) => goal?.condition.includes('简单问题')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(events.some((goal) => goal?.condition.includes('简单问题')),
        '当前 CLI 未在 25 秒内发出 active_goal 事件').toBe(true)
      await client.interrupt()
      abort.abort()
      await turn
    } finally {
      abort.abort()
      clearTimeout(timeout)
      await client?.dispose()
      const relative = path.relative(process.cwd(), probeDir)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe live test cleanup path.')
      await fs.rm(probeDir, { recursive: true, force: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      })
    }
  }, 100_000)
  it.skipIf(!runLive)('continues a saved SDK session with a second user turn', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const marker = `TIDE-${randomUUID().slice(0, 8)}`
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const first = await client.respond([{ role: 'user', content: `记住标记 ${marker}，只回答“记住了”。` }], abort.signal)
      expect(first.sdkSessionId).toBeTruthy()
      const usage = await client.getContextUsage(first.sdkSessionId)
      expect(usage.status).toBe('available')
      expect(usage.maxTokens).toBeGreaterThan(0)
      let secondUsage: TaskUsage | undefined
      const second = await client.respond([
        { role: 'user', content: `记住标记 ${marker}，只回答“记住了”。` },
        { role: 'assistant', content: first.text },
        { role: 'user', content: '刚才的标记是什么？只输出标记。' }
      ], abort.signal, undefined, first.sdkSessionId, undefined, (usage) => { secondUsage = usage })
      expect(second.text).toContain(marker)
      expect(second.sdkSessionId).toBe(first.sdkSessionId)
      // A resumed session is where the summary's zeroed output bucket showed up
      // first: its accumulated usage must still count the reply tokens.
      expect(secondUsage?.input ?? 0).toBeGreaterThan(0)
      expect(secondUsage?.output ?? 0).toBeGreaterThan(0)
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('reports measured output tokens for a live turn', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    let lastUsage: TaskUsage | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      await fs.writeFile(path.join(probeDir, 'probe.txt'), 'TIDE', 'utf8')
      client = new ClaudeAgentClient(executable, apiKey, probeDir, path.join(probeDir, 'claude'))
      // A tool-using turn, the shape the panel shows every day: the plain-reply
      // shape measured fine, the summary only ever went wrong on turns with
      // tool calls in them.
      const reply = await client.respond([{ role: 'user', content: '读一下 probe.txt，然后只回答两个字：收到。' }], abort.signal,
        undefined, undefined, undefined, (usage) => { lastUsage = usage })
      expect(reply.text.length).toBeGreaterThan(0)
      // The panel's footer lies when output reads 0: the SDK's result summary
      // has carried a zeroed output count on this backend, so the turn must
      // keep reporting the measured assistant usage when that happens.
      expect(lastUsage?.input ?? 0).toBeGreaterThan(0)
      expect(lastUsage?.output ?? 0).toBeGreaterThan(0)
    } finally {
      abort.abort()
      clearTimeout(timeout)
      await client?.dispose()
      const relative = path.relative(process.cwd(), probeDir)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe live test cleanup path.')
      await fs.rm(probeDir, { recursive: true, force: true }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== 'EBUSY') throw error
      })
    }
  }, 100_000)

  it.skipIf(!runLive)('reads a disposable project file without an approval prompt', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 90_000)
    const marker = randomUUID()
    const packagedDirectory = path.join(process.cwd(), 'release', 'preview-agent-balance', 'win-unpacked')
    const workspace = resolveAgentWorkspace(packagedDirectory, true, {}, process.cwd())
    expect(workspace).toBe(process.cwd())
    const probeDir = path.join(workspace, '.cache', 'tests', randomUUID())
    const probe = path.join(probeDir, 'probe.txt')
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      await fs.writeFile(probe, marker, 'utf8')
      client = new ClaudeAgentClient(executable, apiKey, workspace, path.join(probeDir, 'claude'))
      const reply = await client.respond([
        { role: 'user', content: `只用 Read 工具读取相对路径 ${path.relative(workspace, probe)}，准确回答文件中的标记；不要修改任何文件。` }
      ], controller.signal)
      expect(reply.text).toContain(marker)
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('guides a running native turn at its next boundary', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const marker = `GUIDE-${randomUUID().slice(0, 8)}`
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const task = client.respond([{ role: 'user', content: '只用 Glob 工具找当前项目中的 package.json，然后用一句中文回答找到了什么。' }], abort.signal)
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      const steered = await client.steer(`完成当前步骤后，在最终答案末尾原样加上 ${marker}。`)
      expect(steered).toBe(true)
      const reply = await task
      expect(reply.text).toContain(marker)
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('runs native manual compaction and refreshes context', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const reply = await client.respond([{ role: 'user', content: '只回答“好的”。' }], abort.signal)
      const after = await client.compact(reply.sdkSessionId)
      expect(after.status).toBe('available')
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('streams model thinking as growing snapshots when the backend provides it', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const thinking: string[] = []
      const reply = await client.respond([
        { role: 'user', content: '请先逐步推理，再回答：三边长分别为 3、4、5 的三角形面积是多少？最后只输出数值。' }
      ], abort.signal, undefined, undefined, undefined, undefined, (text) => { if (text) thinking.push(text) })
      expect(reply.text).toContain('6')
      // Observation: log how much thinking content this backend streams, then
      // assert our snapshot invariant on whatever arrived.
      console.log(`[thinking-probe] chunks=${thinking.length} chars=${thinking.join('').length}`)
      for (let index = 1; index < thinking.length; index += 1) {
        expect(thinking[index].startsWith(thinking[index - 1])).toBe(true)
      }
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('discovers linked user skills and commands with isolated SDK config', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const fakeHome = path.join(probeDir, 'home')
    const configDir = path.join(probeDir, 'config')
    const workspace = path.join(probeDir, 'workspace')
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(path.join(fakeHome, '.claude', 'skills', 'tide-test-skill'), { recursive: true })
      await fs.mkdir(path.join(fakeHome, '.claude', 'commands'), { recursive: true })
      await fs.mkdir(workspace, { recursive: true })
      await fs.writeFile(path.join(fakeHome, '.claude', 'skills', 'tide-test-skill', 'SKILL.md'),
        '---\nname: tide-test-skill\ndescription: Harmless test skill.\n---\nOnly answer OK.\n', 'utf8')
      await fs.writeFile(path.join(fakeHome, '.claude', 'commands', 'tide-test-cmd.md'),
        '---\ndescription: Harmless test command.\n---\nOnly answer OK.\n', 'utf8')
      await linkClaudeUserResources(configDir, fakeHome)
      expect((await fs.lstat(path.join(configDir, 'skills'))).isSymbolicLink()).toBe(true)
      client = new ClaudeAgentClient(executable, apiKey, workspace, configDir)
      await client.respond([{ role: 'user', content: '只回答 OK。' }], abort.signal)
      const catalog = client.getCommandCatalog()
      expect(catalog.skills).toContain('tide-test-skill')
      expect(catalog.commands.some((command) => command.includes('tide-test-cmd'))).toBe(true)
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('parks an AskUserQuestion until the host answers it', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 120_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const parked: AskQuestionRequest[] = []
      let cleared = false
      client.setQuestionListener((question) => {
        if (question) parked.push(question)
        else cleared = true
      })
      // A random passphrase makes the assertion honest: the model cannot invent
      // it, so the reply can only contain it if the parked answer reached the CLI.
      const marker = `TIDE-${randomUUID().slice(0, 8)}`
      const task = client.respond([
        { role: 'user', content: `使用 AskUserQuestion 工具问我：“请选择本次口令”，提供“${marker}-A”和“${marker}-B”两个选项、单选。拿到我的回答后，只输出我选择的口令全文，不要做其他事。` }
      ], abort.signal)
      const deadline = Date.now() + 60_000
      while (!parked.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 200))
      expect(parked.length).toBeGreaterThan(0)
      const request = parked[0]
      const question = request.questions[0]
      const label = question.options.find((option) => option.label.includes(`${marker}-A`))?.label ?? question.options[0]?.label
      expect(label).toBeTruthy()
      expect(client.answerQuestion(request.id, { [question.key]: label! })).toBe(true)
      const reply = await task
      expect(reply.text).toContain(label!)
      expect(cleared).toBe(true)
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 130_000)

  it.skipIf(!runLive)('parks an ExitPlanMode until the host approves the plan', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 240_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const parked: (PlanApprovalRequest | null)[] = []
      client.setPlanListener((plan) => parked.push(plan))
      await client.setPlanMode(true)
      // The passphrase can only reach the panel if ExitPlanMode's own input
      // carried it, so finding it in the parked plan proves the real path.
      const marker = `PLAN-${randomUUID().slice(0, 8)}`
      const tools: string[] = []
      let settled = false
      let outcome = '仍在运行'
      const task = client.respond([
        { role: 'user', content: `请依次使用两个工具：先用 EnterPlanMode 进入计划模式，然后不要调研任何内容、立即用 ExitPlanMode 提交一份只有一句话的实施计划——计划文本必须原样包含口令 ${marker}。提交后停下来等我的批准；批准之后把口令 ${marker} 原样告诉我。` }
      ], abort.signal, undefined, undefined, (event) => {
        if (event.phase === 'start') tools.push(`${event.toolName}${event.input ? `(${event.input.slice(0, 220)})` : '()'}`)
      })
      void task.then(
        (reply) => { settled = true; outcome = `完成：${reply.text.slice(0, 160)}` },
        (error: unknown) => { settled = true; outcome = `失败：${String(error).slice(0, 160)}` })
      const deadline = Date.now() + 120_000
      while (!parked.length && !settled && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 300))
      expect(parked.length, `计划没有进入等待批准；轨迹：${tools.join(' | ') || '（无）'}；结果：${outcome}`).toBeGreaterThan(0)
      const plan = parked[0]!
      expect(plan.plan).toContain(marker)
      expect(client.answerPlan(plan.id, true)).toBe(true)
      const reply = await task
      // The greeting can only carry the passphrase if the approval released the
      // CLI from plan mode and let the turn run to completion.
      expect(tools.some((tool) => tool.startsWith('ExitPlanMode('))).toBe(true)
      expect(reply.text).toContain(marker)
      expect(parked[1]).toBeNull()
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 260_000)

  it.skipIf(!runLive)('keeps the TaskCreate tool available on this provider', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 90_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      // Engine builds since 2.1.233 hide the todo/task tools on models they do
      // not recognise; the client environment sets CLAUDE_CODE_ENABLE_TODO_TOOLS
      // to keep them. A real call is the proof — without the tool, the model
      // cannot make one.
      const tools: string[] = []
      await client.respond(
        [{ role: 'user', content: '请调用 TaskCreate 工具创建一个主题为「潮汐测试」的新任务，然后只回答 OK。' }],
        abort.signal, undefined, undefined,
        (event) => { if (event.phase === 'start') tools.push(event.toolName) }
      )
      console.log(`[task-tools] called=${tools.join(',') || '（无）'}`)
      expect(tools).toContain('TaskCreate')
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 100_000)

  it.skipIf(!runLive)('keeps the TaskCreate tool available after a session resume', async () => {
    const executable = findClaudeExecutable(process.env)
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim()
    if (!executable || !apiKey) throw new Error('本机 Claude Code 或 DeepSeek Key 未就绪。')
    const probeDir = path.join(process.cwd(), '.cache', 'tests', randomUUID())
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 120_000)
    let client: ClaudeAgentClient | undefined
    try {
      await fs.mkdir(probeDir, { recursive: true })
      client = new ClaudeAgentClient(executable, apiKey, process.cwd(), path.join(probeDir, 'claude'))
      const first = await client.respond([{ role: 'user', content: '只回答 OK。' }], abort.signal)
      expect(first.sdkSessionId).toBeTruthy()
      // The app's everyday path: a saved session comes back through --resume.
      // The todo/task tools must survive that trip, not just a fresh start.
      const tools: string[] = []
      await client.respond(
        [
          { role: 'user', content: '只回答 OK。' },
          { role: 'assistant', content: first.text },
          { role: 'user', content: '请调用 TaskCreate 工具创建一个主题为「续潮测试」的新任务，然后只回答 OK。' }
        ],
        abort.signal, undefined, first.sdkSessionId,
        (event) => { if (event.phase === 'start') tools.push(event.toolName) }
      )
      console.log(`[task-tools-resume] called=${tools.join(',') || '（无）'}`)
      expect(tools).toContain('TaskCreate')
    } finally {
      clearTimeout(timeout)
      await client?.dispose()
      await fs.rm(probeDir, { recursive: true, force: true })
    }
  }, 140_000)
})
