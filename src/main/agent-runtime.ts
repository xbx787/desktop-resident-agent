import type { AppSnapshot, ModelMode, ProposedAction, TimelineEntry } from '../shared/contracts'
import type { DialogueLine, ModelClient, ModelReply, ToolApprovalRequest } from './deepseek'
import { NoteStore, type NoteDraft } from './note-store'

const DEMO_HINT = '演示模式仅支持「记录：内容」的测试笔记流程。'

export class AgentRuntime {
  private readonly state: AppSnapshot
  private readonly history: DialogueLine[] = []
  private readonly configuredModel: ModelClient | undefined
  private readonly claudeCodeModel: ModelClient | undefined
  private model: ModelClient | undefined
  private draft?: NoteDraft
  private pendingTool?: { id: string; resolve: (allowed: boolean) => void; cleanup: () => void }
  private activeRequest?: AbortController
  private generation = 0

  constructor(
    private readonly store: NoteStore,
    model: ModelClient | undefined,
    private readonly onChange: (snapshot: AppSnapshot) => void = () => {},
    claudeCodeModel?: ModelClient
  ) {
    this.configuredModel = model
    this.claudeCodeModel = claudeCodeModel
    this.model = claudeCodeModel ?? model
    this.state = {
      mode: claudeCodeModel ? 'claude_code' : model ? 'live' : 'demo',
      modelReady: Boolean(model),
      claudeCodeReady: Boolean(claudeCodeModel),
      avatarState: 'idle',
      taskStatus: 'idle',
      timeline: []
    }
  }

  setModelMode(mode: ModelMode): void {
    if (this.isBusy()) throw new Error('任务进行中时不能切换模型。')
    if (mode === 'live' && !this.configuredModel) throw new Error('尚未配置 DeepSeek API Key。')
    if (mode === 'claude_code' && !this.claudeCodeModel) throw new Error('Claude Code 或 DeepSeek API Key 尚未就绪。')
    if (this.state.mode === mode) return
    this.model = mode === 'claude_code' ? this.claudeCodeModel : mode === 'live' ? this.configuredModel : undefined
    this.state.mode = mode
    this.state.modelReady = Boolean(this.configuredModel)
    this.add('system', mode === 'claude_code' ? '已切换到 Claude Code · DeepSeek。' : mode === 'live' ? '已切换到 DeepSeek Flash。' : '已切换到演示模式。')
  }

  getSnapshot(): AppSnapshot {
    return structuredClone(this.state)
  }

  async sendMessage(rawText: string, attachments: Array<{ name: string; content: string }> = []): Promise<void> {
    const text = rawText.trim()
    if (attachments.length > 5 || attachments.some(({ name, content }) => name.length > 260 || content.length > 32_768)) {
      this.add('system', '附件数量或大小超过限制。')
      return
    }
    const attachmentContext = attachments.map(({ name, content }) => `\n\n[用户附件：${name}]\n${content}`).join('')
    const prompt = [text, attachmentContext].filter(Boolean).join('\n\n')
    if (!prompt) return
    if (prompt.length > 8_000) {
      this.add('system', '单条消息目前最多 8000 字。')
      return
    }
    if (this.isBusy()) {
      this.add('system', '当前任务尚未结束；请先处理待批准操作，或按“停止”。')
      return
    }

    this.generation += 1
    const currentGeneration = this.generation
    this.draft = undefined
    this.state.proposal = undefined
    this.state.currentTask = (text || `阅读附件：${attachments.map(({ name }) => name).join('、')}`).slice(0, 140)
    this.state.taskStatus = 'planning'
    this.state.avatarState = 'thinking'
    this.history.push({ role: 'user', content: prompt })
    this.add('user', attachments.length ? `${text || '请阅读附件并帮助我。'}\n附件：${attachments.map(({ name }) => name).join('、')}` : text)

    if (!this.model) {
      const noteBody = /^(?:记录|记下|测试笔记)\s*[:：]\s*([\s\S]+)$/u.exec(text)?.[1]?.trim()
      if (noteBody) {
        const title = noteBody.split(/\r?\n/u, 1)[0].slice(0, 40) || '测试笔记'
        this.offerNote(title, noteBody)
      } else {
        this.finishWithText(DEMO_HINT)
      }
      return
    }

    const abort = new AbortController()
    this.activeRequest = abort
    let progressEntryId: string | undefined
    try {
      const reply = await this.model.respond([...this.history], abort.signal, (partial) => {
        if (currentGeneration !== this.generation || !partial) return
        if (!progressEntryId) {
          progressEntryId = crypto.randomUUID()
          this.state.timeline.push({ id: progressEntryId, time: new Date().toISOString(), kind: 'assistant', text: partial })
          if (this.state.timeline.length > 80) this.state.timeline.shift()
        } else {
          const entry = this.state.timeline.find((item) => item.id === progressEntryId)
          if (entry) entry.text = partial
        }
        this.emit()
      }, (request, signal) => this.requestToolApproval(request, signal, currentGeneration))
      if (currentGeneration !== this.generation) return
      this.handleModelReply(reply, progressEntryId)
    } catch (error) {
      if (currentGeneration !== this.generation) return
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.add('system', error instanceof Error ? error.message : '模型请求失败。')
    } finally {
      if (currentGeneration === this.generation) this.activeRequest = undefined
    }
  }

  async approveAction(id: string): Promise<void> {
    if (this.pendingTool?.id === id && this.state.taskStatus === 'awaiting_approval') {
      const pending = this.pendingTool
      this.pendingTool = undefined
      pending.cleanup()
      this.state.proposal = undefined
      this.state.taskStatus = 'executing'
      this.state.avatarState = 'acting'
      this.add('system', '已允许这一步操作，正在等待 Claude Code 执行结果。')
      pending.resolve(true)
      return
    }
    if (this.state.taskStatus !== 'awaiting_approval' || !this.draft || this.draft.id !== id) {
      this.add('system', '这项操作已经失效，未执行写入。')
      return
    }
    const draft = this.draft
    this.draft = undefined
    this.state.proposal = undefined
    this.state.taskStatus = 'executing'
    this.state.avatarState = 'acting'
    this.add('system', '已批准，正在创建新的测试笔记。')

    try {
      const target = await this.store.createAndVerify(draft)
      this.state.taskStatus = 'verifying'
      this.emit()
      const message = `已创建并读回核验：${target}`
      this.state.taskStatus = 'done'
      this.state.avatarState = 'success'
      this.history.push({ role: 'assistant', content: message })
      this.add('tool', message)
    } catch (error) {
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.add('system', error instanceof Error ? error.message : '测试笔记写入失败。')
    }
  }

  rejectAction(id: string): void {
    if (this.pendingTool?.id === id && this.state.taskStatus === 'awaiting_approval') {
      const pending = this.pendingTool
      this.pendingTool = undefined
      pending.cleanup()
      this.state.proposal = undefined
      this.state.taskStatus = 'planning'
      this.state.avatarState = 'thinking'
      this.add('system', '已拒绝这一步操作，Claude Code 将继续寻找其他办法。')
      pending.resolve(false)
      return
    }
    if (this.state.taskStatus !== 'awaiting_approval' || this.draft?.id !== id) return
    this.draft = undefined
    this.state.proposal = undefined
    this.state.taskStatus = 'cancelled'
    this.state.avatarState = 'idle'
    this.add('system', '已拒绝，本次没有写入文件。')
  }

  stop(): void {
    if (this.state.mode !== 'claude_code' && (this.state.taskStatus === 'executing' || this.state.taskStatus === 'verifying')) {
      this.add('system', '写入已经开始，当前步骤会完成读回验证；不会继续执行其他动作。')
      return
    }
    if (!this.isBusy()) return
    this.generation += 1
    const pending = this.pendingTool
    this.pendingTool = undefined
    pending?.cleanup()
    pending?.resolve(false)
    this.activeRequest?.abort()
    this.activeRequest = undefined
    this.draft = undefined
    this.state.proposal = undefined
    this.state.taskStatus = 'cancelled'
    this.state.avatarState = 'idle'
    this.add('system', this.state.mode === 'claude_code' ? '已请求停止 Claude Code；正在执行的外部动作可能仍会完成。' : '任务已停止，待批准的操作已取消。')
  }

  private requestToolApproval(request: ToolApprovalRequest, signal: AbortSignal, generation: number): Promise<boolean> {
    if (generation !== this.generation || signal.aborted || this.state.mode !== 'claude_code') return Promise.resolve(false)
    if (!['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write'].includes(request.toolName) || this.pendingTool) return Promise.resolve(false)
    const content = JSON.stringify(request.input, null, 2)
    if (!content || content.length > 30_000) {
      this.add('system', '工具输入过大，已拒绝这一步操作。')
      return Promise.resolve(false)
    }
    const target = [request.input.file_path, request.input.command, request.input.path, request.input.pattern]
      .find((value): value is string => typeof value === 'string' && value.length > 0) ?? request.toolName
    const risk = request.toolName === 'Bash' ? 'execute' : request.toolName === 'Edit' || request.toolName === 'Write' ? 'write' : 'read'
    const id = crypto.randomUUID()
    this.state.proposal = {
      id,
      tool: 'claude_tool',
      description: `Claude Code 请求使用 ${request.toolName}。请查看完整参数后决定是否允许。`,
      target,
      content,
      risk
    }
    this.state.taskStatus = 'awaiting_approval'
    this.state.avatarState = 'thinking'
    this.add('system', `Claude Code 请求 ${request.toolName}，等待你决定。`)
    return new Promise<boolean>((resolve) => {
      const onAbort = (): void => {
        if (this.pendingTool?.id !== id) return
        this.pendingTool = undefined
        this.state.proposal = undefined
        resolve(false)
      }
      this.pendingTool = { id, resolve, cleanup: () => signal.removeEventListener('abort', onAbort) }
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  private isBusy(): boolean {
    return ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(this.state.taskStatus)
  }

  private handleModelReply(reply: ModelReply, progressEntryId?: string): void {
    if (reply.text) {
      this.history.push({ role: 'assistant', content: reply.text })
      const progressEntry = this.state.timeline.find((entry) => entry.id === progressEntryId)
      if (progressEntry) {
        progressEntry.text = reply.text
        this.emit()
      } else this.add('assistant', reply.text)
    }
    if (reply.note) {
      this.offerNote(reply.note.title, reply.note.content)
    } else {
      this.state.taskStatus = 'done'
      this.state.avatarState = 'idle'
      this.emit()
    }
  }

  private offerNote(title: string, content: string): void {
    try {
      const draft = this.store.makeDraft(title, content)
      this.draft = draft
      const proposal: ProposedAction = {
        id: draft.id,
        tool: 'write_test_note',
        description: '在项目测试目录创建一份新的 Markdown 笔记',
        target: draft.target,
        content: draft.content,
        risk: 'write'
      }
      this.state.proposal = proposal
      this.state.taskStatus = 'awaiting_approval'
      this.state.avatarState = 'thinking'
      this.add('system', '笔记草稿已准备好，请查看路径和内容后决定是否写入。')
    } catch (error) {
      this.state.taskStatus = 'failed'
      this.state.avatarState = 'error'
      this.add('system', error instanceof Error ? error.message : '无法准备笔记草稿。')
    }
  }

  private finishWithText(text: string): void {
    this.history.push({ role: 'assistant', content: text })
    this.state.taskStatus = 'done'
    this.state.avatarState = 'idle'
    this.add('assistant', text)
  }

  private add(kind: TimelineEntry['kind'], text: string): void {
    this.state.timeline.push({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      kind,
      text
    })
    if (this.state.timeline.length > 80) this.state.timeline.shift()
    this.emit()
  }

  private emit(): void {
    this.onChange(this.getSnapshot())
  }
}
