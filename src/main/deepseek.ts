import { buildXiaojingPersona } from './persona'
import type { AgentGoal, ApprovalMode, AskAnswers, AskQuestionRequest, CompactionState, EffortLevel, PlanApprovalRequest, TaskUsage, ToolPermissionRequest } from '../shared/contracts'

export interface DialogueLine {
  role: 'user' | 'assistant'
  content: string
  /** Frozen @conversation data for this user message. Main-process only;
   * model requests expand it into content, while the visible text stays clean. */
  sessionContext?: string
}

export interface ModelReply {
  text: string
  note?: { title: string; content: string }
  sdkSessionId?: string | null
  compacted?: boolean
  /** 连续生成的累计时长（毫秒；相邻流式增量间隔 ≤1.5s 的时段之和）——
   *  token/s 的分母，不含工具执行与等待。非流式路径没有这个字段。 */
  generationMs?: number
  /** The user stopped this turn on purpose; it ended without a failure. */
  interrupted?: boolean
  /** The model already emitted its final text through onProgress in timeline order. */
  timelineHandled?: boolean
}

export interface ModelToolEvent {
  toolUseId: string
  toolName: string
  phase: 'start' | 'result'
  input?: string
  output?: string
  isError?: boolean
}

export interface ModelClient {
  respond(
    history: DialogueLine[],
    signal: AbortSignal,
    onProgress?: (text: string, segment?: number) => void,
    sdkSessionId?: string | null,
    onToolEvent?: (event: ModelToolEvent) => void,
    onTaskUsage?: (usage: TaskUsage) => void,
    onThinking?: (text: string, segment?: number) => void
  ): Promise<ModelReply>
  /** Clients that can control thinking depth implement this. */
  setEffort?(level: EffortLevel): void
  /** Clients that can plan-first implement this. */
  /** false means a cold query has not yet sent an SDK confirmation. */
  setPlanMode?(on: boolean): Promise<boolean | void> | boolean | void
  setPlanModeListener?(listener: (on: boolean) => void): void
  /** Clients that can switch permission modes implement this. */
  setApprovalMode?(mode: ApprovalMode): Promise<boolean | void> | boolean | void
  /** Clients that can remove web tools implement this. */
  setWebSearchEnabled?(on: boolean): void
  /** Clients that can change the auto-compaction threshold implement this. */
  setAutoCompactPercent?(percent: number): void
  /** Clients that switch the persona preset implement this. */
  setPersonaId?(id: string): void
  setApprovalModeListener?(listener: (mode: ApprovalMode) => void): void
  /** Clients that park tool calls for approval implement this. */
  setPermissionListener?(listener: (request: ToolPermissionRequest | null) => void): void
  answerPermission?(id: string, allow: boolean): boolean
  /** Compaction start/end; `auto` marks the CLI's own threshold trigger. */
  setCompactingListener?(listener: (state: CompactionState) => void): void
  /** Clients that can abort what the current turn is doing implement this
   *  (the SDK client maps it to the CLI's own Esc). */
  interrupt?(): Promise<void>
  /** Clients that can point at a different model endpoint implement this;
   *  undefined returns to the launch environment. */
  setProvider?(provider?: { baseUrl: string; apiKey: string; model: string; smallModel?: string; extraEnv?: string }): void
  /** Clients whose persona greets by name implement this. */
  setIdentity?(identity?: { userName?: string; assistantName?: string }): void
  /** Clients that surface the /goal state implement this. */
  setGoalListener?(listener: (goal: AgentGoal | null) => void): void
  /** Clients that relay interactive questions implement this. The listener
   *  receives the parked question, then null once it is settled. */
  setQuestionListener?(listener: (question: AskQuestionRequest | null) => void): void
  /** Resolves a parked question; returns false when the id is stale. */
  answerQuestion?(id: string, answers: AskAnswers | null): boolean
  /** Clients that relay plan approvals implement this. The listener receives
   *  the parked plan, then null once it is settled. */
  setPlanListener?(listener: (plan: PlanApprovalRequest | null) => void): void
  /** Resolves a parked plan; returns false when the id is stale. */
  answerPlan?(id: string, approved: boolean): boolean
}

interface ApiContent {
  type?: string
  text?: string
}

interface ApiOutput {
  type?: string
  name?: string
  arguments?: string
  content?: ApiContent[]
}

interface ApiResponse {
  status?: string
  output?: ApiOutput[]
  usage?: { total_tokens?: number }
}

const INSTRUCTIONS_TAIL = [
  '当前阶段你只有一个工具：在应用自己的 sandbox/notes 目录创建一份新的测试笔记。',
  '工具调用只会提出草稿，必须由用户在界面上批准后才会执行。',
  '不要声称已经执行、读取或验证任何尚未由工具返回结果的操作。',
  '若用户请求操作其他文件、应用或命令，请说明当前版本暂不支持。',
  '不要主动收集秘密、密钥或私有文件。'
].join('\n')

export class DeepSeekClient implements ModelClient {
  constructor(private readonly apiKey: string) {}

  private effort: EffortLevel = 'max'
  private identity?: { userName?: string; assistantName?: string }

  /** The names the persona addresses. */
  setIdentity(identity?: { userName?: string; assistantName?: string }): void {
    this.identity = identity
  }

  /** Responses-API field: DeepSeek documents none/low/high/max here, and `none`
   *  is the real off switch — same four stops as the Anthropic-format slider. */
  setEffort(level: EffortLevel): void {
    this.effort = level
  }

  async respond(history: DialogueLine[], signal: AbortSignal,
    _onProgress?: (text: string, segment?: number) => void,
    _sdkSessionId?: string | null,
    _onToolEvent?: (event: ModelToolEvent) => void,
    onTaskUsage?: (usage: TaskUsage) => void,
    _onThinking?: (text: string, segment?: number) => void): Promise<ModelReply> {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        instructions: [buildXiaojingPersona({ userAddress: this.identity?.userName, assistantName: this.identity?.assistantName }), INSTRUCTIONS_TAIL].join('\n'),
        reasoning: { effort: this.effort === 'off' ? 'none' : this.effort },
        input: history.slice(-20).map((line) => ({ role: line.role, content: line.content })),
        max_output_tokens: 1200,
        tool_choice: 'auto',
        tools: [
          {
            type: 'function',
            name: 'write_test_note',
            description: 'Propose a new markdown note inside the application test directory. User approval is required before writing.',
            parameters: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A short note title' },
                content: { type: 'string', description: 'The note body' }
              },
              required: ['title', 'content'],
              additionalProperties: false
            }
          }
        ]
      }),
      signal
    })

    if (!response.ok) throw new Error(`DeepSeek API 返回 HTTP ${response.status}。`)
    const data = (await response.json()) as ApiResponse
    if (data.status && data.status !== 'completed') {
      throw new Error(`DeepSeek 响应未完成：${data.status}。`)
    }
    const totalTokens = data.usage?.total_tokens
    if (typeof totalTokens === 'number' && Number.isSafeInteger(totalTokens) && totalTokens >= 0) {
      onTaskUsage?.({ total: totalTokens })
    }
    const output = data.output ?? []
    const calls = output.filter((item) => item.type === 'function_call')
    if (calls.length > 1) throw new Error('模型一次提出了多项操作；当前版本仅接受一项。')
    const text = output
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n')
      .trim()

    if (calls.length === 0) return { text: text || '这次没有生成可显示的回复。' }
    const call = calls[0]
    if (call.name !== 'write_test_note' || typeof call.arguments !== 'string') {
      throw new Error('模型提出了不支持的工具调用。')
    }
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      throw new Error('模型提供的工具参数不是有效 JSON。')
    }
    if (!args || typeof args !== 'object') throw new Error('工具参数无效。')
    const { title, content } = args as Record<string, unknown>
    if (typeof title !== 'string' || typeof content !== 'string') {
      throw new Error('工具参数缺少标题或内容。')
    }
    if (title.length > 200 || content.length > 20_000) {
      throw new Error('模型提出的笔记超过当前版本的长度限制。')
    }
    return { text, note: { title, content } }
  }
}
