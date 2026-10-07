export interface DialogueLine {
  role: 'user' | 'assistant'
  content: string
}

export interface ModelReply {
  text: string
  note?: { title: string; content: string }
}

export interface ToolApprovalRequest {
  toolName: string
  input: Record<string, unknown>
  toolUseId?: string
}

export interface ModelClient {
  respond(
    history: DialogueLine[],
    signal: AbortSignal,
    onProgress?: (text: string) => void,
    onToolApproval?: (request: ToolApprovalRequest, signal: AbortSignal) => Promise<boolean>
  ): Promise<ModelReply>
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
}

const INSTRUCTIONS = [
  '你是住在 Windows 电脑中的中文鲸鱼娘助手，语气自然、简洁。',
  '当前阶段你只有一个工具：在应用自己的 sandbox/notes 目录创建一份新的测试笔记。',
  '工具调用只会提出草稿，必须由用户在界面上批准后才会执行。',
  '不要声称已经执行、读取或验证任何尚未由工具返回结果的操作。',
  '若用户请求操作其他文件、应用或命令，请说明当前版本暂不支持。',
  '不要主动收集秘密、密钥或私有文件。'
].join('\n')

export class DeepSeekClient implements ModelClient {
  constructor(private readonly apiKey: string) {}

  async respond(history: DialogueLine[], signal: AbortSignal): Promise<ModelReply> {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        instructions: INSTRUCTIONS,
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
