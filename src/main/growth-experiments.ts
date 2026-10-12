import { query, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { GrowthProposal, TimelineEntry } from '../shared/contracts'
import { CLAUDE_BASE_URL, DEFAULT_CLAUDE_MODEL, claudeEnvironment } from './claude-code'
import { GrowthStore } from './growth-store'

export interface GrowthProvider {
  baseUrl: string
  apiKey: string
  model: string
  smallModel?: string
  extraEnv?: string
}

type CommandResult = { output: string; code: number; truncated?: boolean }
export type GrowthCommand = (executable: string, args: string[], cwd: string) => Promise<CommandResult>

/** No shell interpolation: callers pass fixed executables and argument arrays. */
export const runGrowthCommand: GrowthCommand = (executable, args, cwd) => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, windowsHide: true, shell: false })
  let output = ''
  let truncated = false
  const collect = (chunk: Buffer): void => {
    output += chunk.toString('utf8')
    if (Buffer.byteLength(output, 'utf8') > 250_000) {
      output = output.slice(-250_000)
      truncated = true
    }
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', reject)
  child.on('close', (code) => resolve({ code: code ?? 1, output, truncated }))
})

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function protectedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate).replace(/\\/gu, '/')
  return /(^|\/)(?:\.git|\.github|\.env(?:\..*)?|node_modules|data|release|out|\.cache|scripts)(?:\/|$)/iu.test(relative) ||
    /^(?:package(?:-lock)?\.json|electron\.vite\.config\.ts|vite\.config\.ts|vitest\.config\.ts|tsconfig[^/]*\.json)$/iu.test(relative)
}

/** Rejects symlink escapes and internal paths before the SDK executes a file tool. */
export async function experimentFileAllowed(root: string, rawPath: string): Promise<boolean> {
  if (!rawPath || rawPath.includes('\0')) return false
  const canonicalRoot = await fs.realpath(root).catch(() => '')
  if (!canonicalRoot) return false
  const target = path.resolve(root, rawPath)
  if (target !== root && !inside(root, target)) return false
  const relative = path.relative(root, target).replace(/\\/gu, '/')
  if (!/^(?:src|test|docs)(?:\/|$)/iu.test(relative)) return false
  if (protectedPath(root, target)) return false
  let existing = target
  while (true) {
    try {
      const resolved = await fs.realpath(existing)
      const suffix = path.relative(existing, target)
      const finalPath = path.resolve(resolved, suffix)
      const finalRelative = path.relative(canonicalRoot, finalPath).replace(/\\/gu, '/')
      return (finalPath === canonicalRoot || inside(canonicalRoot, finalPath)) &&
        /^(?:src|test|docs)(?:\/|$)/iu.test(finalRelative) && !protectedPath(canonicalRoot, finalPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false
      const parent = path.dirname(existing)
      if (parent === existing) return false
      existing = parent
    }
  }
}

const experimentTools = new Set(['Read', 'Grep', 'Glob', 'Edit', 'Write'])

export async function experimentToolAllowed(root: string, name: string, input: unknown): Promise<boolean> {
  if (!experimentTools.has(name) || !input || typeof input !== 'object') return false
  const record = input as Record<string, unknown>
  const candidate = record.file_path ?? record.path
  if (typeof candidate !== 'string' || !await experimentFileAllowed(root, candidate)) return false
  const filePattern = name === 'Glob' ? record.pattern : name === 'Grep' ? record.glob : undefined
  if (filePattern !== undefined) {
    if (typeof filePattern !== 'string') return false
    const pattern = filePattern.replace(/\\/gu, '/')
    if (path.isAbsolute(filePattern) || pattern.startsWith('/') || pattern.startsWith('~') ||
      /(^|\/)(?:\.\.|\.git|\.github|\.env[^/]*|node_modules|data|release|out|\.cache|scripts)(\/|$)/iu.test(pattern)) return false
  }
  return true
}

function containsCredential(value: string): boolean {
  return /sk-[A-Za-z0-9_-]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|auth[_-]?token|password|secret)\s*[:=]\s*['"][^'"]{12,}['"]/iu.test(value)
}

function containsProviderSecret(value: string, provider: GrowthProvider): boolean {
  if (provider.apiKey.length >= 8 && value.includes(provider.apiKey)) return true
  for (const line of provider.extraEnv?.split(/\r?\n/u) ?? []) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const candidate = line.slice(separator + 1).trim()
    if (candidate.length >= 8 && value.includes(candidate)) return true
  }
  return false
}

function secretSafe(value: string, secret?: string, extraEnv?: string): string {
  let text = value.replace(/sk-[A-Za-z0-9_-]{16,}/gu, '[已隐藏密钥]')
  if (secret) text = text.replaceAll(secret, '[已隐藏密钥]')
  for (const line of extraEnv?.split(/\r?\n/u) ?? []) {
    const separator = line.indexOf('=')
    if (separator < 0) continue
    const candidate = line.slice(separator + 1).trim()
    if (candidate.length >= 8) text = text.replaceAll(candidate, '[已隐藏密钥]')
  }
  return text.slice(-8_000)
}

export interface GrowthExperimentOptions {
  projectRoot: string
  dataRoot: string
  claudeExecutable?: string
  provider: () => Promise<GrowthProvider | null>
  onChange?: () => void
  command?: GrowthCommand
  /** Test seam; production uses the restricted Claude SDK query below. */
  agent?: (worktree: string, proposal: GrowthProposal, provider: GrowthProvider) => Promise<void>
}

export class GrowthExperiments {
  readonly store: GrowthStore
  private readonly command: GrowthCommand
  private readonly busy = new Set<string>()

  constructor(private readonly options: GrowthExperimentOptions) {
    this.store = new GrowthStore(options.dataRoot)
    this.command = options.command ?? runGrowthCommand
  }

  private async run(executable: string, args: string[], cwd = this.options.projectRoot): Promise<string> {
    const result = await this.command(executable, args, cwd)
    if (result.code !== 0) throw new Error(`${path.basename(executable)} 失败，退出码 ${result.code}。`)
    if (result.truncated) throw new Error(`${path.basename(executable)} 输出过长，无法可靠审阅。`)
    return result.output.trim()
  }

  private async git(args: string[], cwd = this.options.projectRoot): Promise<string> {
    return this.run('git.exe', args, cwd)
  }

  private async npm(args: string[], cwd: string): Promise<string> {
    return this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& npm.cmd ${args.join(' ')}`], cwd)
  }

  private worktreeOf(id: string): string {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) throw new Error('提案编号无效。')
    return path.join(this.options.dataRoot, 'experiments', 'worktrees', id)
  }

  private async prepareDependencies(worktree: string): Promise<void> {
    const source = path.join(this.options.projectRoot, 'node_modules')
    const destination = path.join(worktree, 'node_modules')
    const sourceStat = await fs.stat(source).catch(() => null)
    if (!sourceStat?.isDirectory()) throw new Error('源码仓库缺少 node_modules，无法执行固定检查。')
    const existing = await fs.lstat(destination).catch(() => null)
    if (existing) {
      const linked = await fs.realpath(destination).catch(() => '')
      const resolved = await fs.realpath(source)
      if (linked !== resolved) throw new Error('实验工作树的依赖目录不指向当前源码仓库。')
      return
    }
    await fs.symlink(source, destination, process.platform === 'win32' ? 'junction' : 'dir')
  }

  private async verifyWorktree(worktree: string, branch: string): Promise<void> {
    const actual = await this.git(['rev-parse', '--show-toplevel'], worktree)
    const expected = await fs.realpath(worktree)
    if (path.resolve(actual).toLowerCase() !== expected.toLowerCase()) {
      throw new Error('实验工作树路径与 Git 登记不一致。')
    }
    if (await this.git(['branch', '--show-current'], worktree) !== branch) {
      throw new Error('实验工作树分支已改变。')
    }
  }

  async availability(): Promise<{ available: boolean; reason?: string }> {
    if (!this.options.claudeExecutable) return { available: false, reason: '本机没有可用的 Claude Code 引擎。' }
    try {
      const root = await this.git(['rev-parse', '--show-toplevel'])
      if (path.resolve(root).toLowerCase() !== path.resolve(this.options.projectRoot).toLowerCase()) {
        return { available: false, reason: '当前程序没有可用的本地源码仓库。' }
      }
      return { available: true }
    } catch {
      return { available: false, reason: '当前程序没有可用的本地源码仓库。' }
    }
  }

  list(): Promise<GrowthProposal[]> { return this.store.list() }

  async propose(title: string, objective: string, evidence: string, sourceConversationId?: string): Promise<GrowthProposal> {
    if ([title, objective, evidence].some(containsCredential)) throw new Error('成长提案可能包含密钥，请先移除。')
    const item = await this.store.propose(title, objective, evidence, sourceConversationId)
    this.options.onChange?.()
    return item
  }

  /** A low-noise, evidence-based suggestion after two failures of one tool. */
  async observeTurn(conversationId: string, timeline: TimelineEntry[]): Promise<void> {
    const errors = timeline.filter((entry) => entry.kind === 'tool' && entry.tool?.status === 'error')
    const byTool = new Map<string, TimelineEntry[]>()
    for (const entry of errors) {
      const name = entry.tool?.name ?? '工具'
      byTool.set(name, [...(byTool.get(name) ?? []), entry])
    }
    for (const [name, entries] of byTool) {
      if (entries.length < 2) continue
      const evidence = entries.slice(-2).map((entry) => secretSafe(entry.tool?.output ?? entry.text).slice(0, 180)).join('；')
      if (containsCredential(evidence)) continue
      await this.propose(`改进 ${name} 的失败处理`, `检查并修复 ${name} 在此会话中反复失败的问题。`, evidence, conversationId)
      break
    }
  }

  private async restrictedAgent(worktree: string, proposal: GrowthProposal, provider: GrowthProvider): Promise<void> {
    if (!this.options.claudeExecutable) throw new Error('Claude Code 引擎不可用。')
    const instruction = [
      '你正在小鲸项目的独立 Git worktree 中做一项已获用户批准的实验。只修改此 worktree 内的项目文件。',
      '你只有 Read、Grep、Glob、Edit、Write 工具；所有文件路径和搜索目录都必须显式指定且位于 src、test 或 docs。不要请求 Bash、MCP、子代理、网络或修改系统配置。',
      '实验结束后简要报告改动；检查与打包由宿主执行。',
      `改进目标：${proposal.objective}`,
      `发现依据：${proposal.evidence}`
    ].join('\n\n')
    const active = query({
      prompt: instruction,
      options: {
        cwd: worktree,
        pathToClaudeCodeExecutable: this.options.claudeExecutable,
        env: claudeEnvironment(process.env, {
          apiKey: provider.apiKey, baseUrl: provider.baseUrl || CLAUDE_BASE_URL,
          model: provider.model || DEFAULT_CLAUDE_MODEL,
          smallModel: provider.smallModel, extraEnv: provider.extraEnv,
          configDir: path.join(this.options.dataRoot, 'claude')
        }),
        model: provider.model,
        systemPrompt: '只在当前 Git worktree 内读写。源仓库、用户数据和其他应用均不在本实验范围内。',
        settingSources: [], skills: [], strictMcpConfig: true, mcpServers: {},
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'],
        disallowedTools: ['Bash', 'Task', 'Skill', 'WebFetch', 'WebSearch'],
        permissionMode: 'default', maxTurns: 35, persistSession: false,
        hooks: {
          PreToolUse: [{ hooks: [async (input) => ({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: input.hook_event_name === 'PreToolUse' &&
                await experimentToolAllowed(worktree, input.tool_name, input.tool_input)
                ? 'allow' : 'deny',
              permissionDecisionReason: '实验只允许访问工作树内的项目文件。'
            }
          })] }]
        },
        canUseTool: async (name, input): Promise<PermissionResult> =>
          await experimentToolAllowed(worktree, name, input)
            ? { behavior: 'allow' }
            : { behavior: 'deny', message: '实验只允许访问工作树内的项目文件。' }
      }
    })
    let finished = false
    try {
      for await (const message of active) {
        if (message.type !== 'result') continue
        finished = true
        if (message.subtype !== 'success' || message.is_error) {
          throw new Error('实验模型未成功完成任务，原始回复未保存。')
        }
      }
    } finally {
      active.close()
    }
    if (!finished) throw new Error('实验会话未返回完成结果。')
  }

  async experiment(id: string): Promise<GrowthProposal> {
    if (this.busy.has(id)) throw new Error('该实验已在运行。')
    this.busy.add(id)
    let provider: GrowthProvider | null = null
    try {
      const proposal = await this.store.get(id)
      if (proposal.status !== 'proposed' && proposal.status !== 'failed') throw new Error('当前提案不能开始实验。')
      const available = await this.availability()
      if (!available.available) throw new Error(available.reason)
      provider = await this.options.provider()
      if (!provider?.apiKey) throw new Error('请先在设置中配置可用的模型密钥。')
      const root = this.options.projectRoot
      const worktree = this.worktreeOf(id)
      const branch = `codex/growth/${id}`
      let baseCommit = proposal.baseCommit
      if (!baseCommit) {
        if (await this.git(['status', '--porcelain'], root)) throw new Error('源码仓库有未提交改动，请先处理后再实验。')
        baseCommit = await this.git(['rev-parse', 'HEAD'], root)
        await fs.mkdir(path.dirname(worktree), { recursive: true })
        await this.git(['worktree', 'add', '-b', branch, worktree, baseCommit], root)
      }
      await this.verifyWorktree(worktree, branch)
      await this.prepareDependencies(worktree)
      await this.store.update(id, { status: 'running', baseCommit, error: undefined })
      this.options.onChange?.()
      await (this.options.agent ?? ((directory, item, config) => this.restrictedAgent(directory, item, config)))(worktree, proposal, provider)
      await this.git(['add', '-A'], worktree)
      const fileList = (await this.git(['diff', '--cached', '--name-only', '-z'], worktree)).split('\0').filter(Boolean)
      if (fileList.length === 0) throw new Error('实验没有产生可审阅的文件改动。')
      if (fileList.length > 30) throw new Error('实验一次修改超过 30 个文件，请缩小范围。')
      for (const file of fileList) {
        if (!await experimentFileAllowed(worktree, file)) throw new Error(`实验修改了范围外的文件：${file}`)
      }
      const diff = await this.git(['diff', '--cached', '--no-ext-diff', '--binary'], worktree)
      if (Buffer.byteLength(diff, 'utf8') > 200_000) throw new Error('实验差异超过 200 KB，请缩小范围。')
      if (containsCredential(diff) || containsProviderSecret(diff, provider)) {
        throw new Error('实验差异可能包含密钥，已停止审阅。')
      }
      const checks: NonNullable<GrowthProposal['checks']> = []
      for (const name of ['check', 'test', 'build'] as const) {
        const result = await this.command('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `& npm.cmd run ${name}`], worktree)
        checks.push({
          name, ok: result.code === 0 && !result.truncated,
          output: result.truncated ? '检查输出过长，未保存原始内容。' : `退出码 ${result.code}`
        })
      }
      const passed = checks.every((item) => item.ok)
      const releaseNotes = [
        '### 改进',
        `- ${proposal.title}：${proposal.objective}`,
        '',
        '### 验证',
        ...checks.map((item) => `- ${item.name}：${item.ok ? '通过' : '失败'}`)
      ].join('\n')
      if (!passed) {
        const failed = await this.store.update(id, { status: 'failed', diff, checks, releaseNotes, error: '检查未全部通过，改动未采纳。' })
        this.options.onChange?.()
        return failed
      }
      await this.git(['commit', '-m', `experiment: ${proposal.title.slice(0, 60)}`], worktree)
      const experimentCommit = await this.git(['rev-parse', 'HEAD'], worktree)
      const ready = await this.store.update(id, { status: 'ready', diff, checks, releaseNotes, experimentCommit, error: undefined })
      this.options.onChange?.()
      return ready
    } catch (error) {
      const failed = await this.store.update(id, {
        status: 'failed',
        error: secretSafe(error instanceof Error ? error.message : String(error), provider?.apiKey, provider?.extraEnv)
      })
      this.options.onChange?.()
      return failed
    } finally {
      this.busy.delete(id)
    }
  }

  async updateReleaseNotes(id: string, notes: string): Promise<GrowthProposal> {
    const proposal = await this.store.get(id)
    if (proposal.status !== 'ready') throw new Error('实验尚未通过验证。')
    const clean = notes.trim().slice(0, 8_000)
    if (!clean) throw new Error('版本说明不能为空。')
    const updated = await this.store.update(id, { releaseNotes: clean })
    this.options.onChange?.()
    return updated
  }

  /** Approval is the only entry point that can change the source branch or shortcuts. */
  async adopt(id: string): Promise<GrowthProposal> {
    if (this.busy.has(id)) throw new Error('该实验已在运行。')
    this.busy.add(id)
    try {
      const proposal = await this.store.get(id)
      if (proposal.status !== 'ready' || !proposal.baseCommit || !proposal.experimentCommit ||
        !proposal.checks?.every((item) => item.ok) || !proposal.releaseNotes) {
        throw new Error('实验尚未达到可采纳条件。')
      }
      const root = this.options.projectRoot
      const worktree = this.worktreeOf(id)
      const branch = `codex/growth/${id}`
      await this.verifyWorktree(worktree, branch)
      if (await this.git(['status', '--porcelain'], root)) throw new Error('源码仓库有未提交改动，采纳已暂停。')
      if (await this.git(['rev-parse', 'HEAD'], root) !== proposal.baseCommit) {
        await this.store.update(id, { status: 'stale', error: '源码基准已改变，请重新实验。' })
        throw new Error('源码基准已改变，请重新实验。')
      }
      if (await this.git(['rev-parse', 'HEAD'], worktree) !== proposal.experimentCommit ||
        await this.git(['status', '--porcelain'], worktree)) throw new Error('实验差异已改变，请重新审阅。')
      const manifest = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')) as { version: string }
      const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(manifest.version)
      if (!match) throw new Error('当前版本号格式无效。')
      let version = ''
      let tag = ''
      let releaseName = ''
      let target = ''
      for (let patch = Number(match[3]) + 1; patch < Number(match[3]) + 101; patch++) {
        version = `${match[1]}.${match[2]}.${patch}`
        tag = `v${version}`
        releaseName = `whale-companion-v${version}`
        target = path.join(root, 'release', releaseName)
        const zip = path.join(root, 'release', `${releaseName}-win-x64.zip`)
        const sum = path.join(root, 'release', `${releaseName}.sha256.txt`)
        const tagCheck = await this.command('git.exe', ['show-ref', '--verify', '--quiet', `refs/tags/${tag}`], root)
        if (tagCheck.code !== 0 && tagCheck.code !== 1) throw new Error('无法核对目标版本标签。')
        if (tagCheck.code !== 0 &&
          !await fs.stat(target).then(() => true, () => false) &&
          !await fs.stat(zip).then(() => true, () => false) &&
          !await fs.stat(sum).then(() => true, () => false)) break
        version = ''
      }
      if (!version) throw new Error('100 个补丁版本均已占用，请检查本地版本目录。')
      await this.npm(['version', version, '--no-git-tag-version'], worktree)
      const changelogPath = path.join(worktree, 'CHANGELOG.md')
      const changelog = await fs.readFile(changelogPath, 'utf8')
      const heading = `## [${version}] - ${new Date().toISOString().slice(0, 10)}`
      await fs.writeFile(changelogPath, changelog.replace(/^# 更新日志\r?\n/u, `# 更新日志\n\n${heading}\n\n${proposal.releaseNotes}\n`), 'utf8')
      await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(worktree, 'scripts', 'pack-release.ps1'), '-NoShortcutSwitch'], worktree)
      const candidate = path.join(worktree, 'release', releaseName)
      await this.run('node.exe', [path.join(worktree, 'scripts', 'extract-release-notes.cjs'), version], worktree)
      await this.git(['add', '-A'], worktree)
      await this.git(['commit', '-m', `release: v${version}`], worktree)
      await fs.mkdir(path.join(root, 'release'), { recursive: true })
      await fs.cp(candidate, target, { recursive: true, errorOnExist: true, force: false })
      await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'make-release-archive.ps1'), '-ReleaseDir', target], root)
      // The source branch moves only after the candidate package and archive exist.
      const releaseCommit = await this.git(['rev-parse', 'HEAD'], worktree)
      await this.git(['merge', '--ff-only', branch], root)
      try {
        await this.git(['tag', tag], root)
        await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'switch-shortcuts.ps1'), '-ProjectRoot', root, '-ReleaseDir', target], root)
      } catch (error) {
        // The source tree was clean before adoption. Roll it back only while
        // HEAD is still our release commit and no other process has changed it.
        if (await this.git(['rev-parse', 'HEAD'], root) === releaseCommit &&
          !await this.git(['status', '--porcelain'], root)) {
          const currentTag = await this.command('git.exe', ['rev-list', '-n', '1', tag], root)
          if (currentTag.code === 0 && currentTag.output.trim() === releaseCommit) {
            await this.git(['tag', '-d', tag], root)
          }
          await this.git(['reset', '--hard', proposal.baseCommit], root)
        }
        throw error
      }
      const adopted = await this.store.update(id, { status: 'adopted', version, error: undefined })
      this.options.onChange?.()
      return adopted
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.store.update(id, { error: secretSafe(message) })
      this.options.onChange?.()
      throw error
    } finally {
      this.busy.delete(id)
    }
  }

  async publish(id: string): Promise<GrowthProposal> {
    const proposal = await this.store.get(id)
    if (proposal.status !== 'adopted' || !proposal.version) throw new Error('请先采纳并打包此版本。')
    await this.run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.options.projectRoot, 'scripts', 'publish-release.ps1'), '-Version', proposal.version])
    const published = await this.store.update(id, { status: 'published' })
    this.options.onChange?.()
    return published
  }

  async discard(id: string): Promise<GrowthProposal> {
    if (this.busy.has(id)) throw new Error('实验正在运行，不能丢弃。')
    const proposal = await this.store.get(id)
    if (proposal.status === 'adopted' || proposal.status === 'published') throw new Error('已采纳的改动不能从提案页丢弃。')
    const worktree = this.worktreeOf(id)
    if (!inside(path.join(this.options.dataRoot, 'experiments'), worktree)) throw new Error('实验目录越界。')
    if (proposal.baseCommit) {
      const actual = await fs.realpath(worktree).catch(() => '')
      const experimentRoot = await fs.realpath(path.join(this.options.dataRoot, 'experiments')).catch(() => '')
      if (!actual || !experimentRoot || !inside(experimentRoot, actual)) {
        throw new Error('实验工作树路径不符合预期，已停止清理。')
      }
      await this.verifyWorktree(worktree, `codex/growth/${id}`)
      await this.git(['worktree', 'remove', '--force', worktree])
      await this.git(['branch', '-D', `codex/growth/${id}`])
    }
    const discarded = await this.store.update(id, { status: 'discarded' })
    this.options.onChange?.()
    return discarded
  }
}
