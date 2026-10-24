/** Local HTTP bridge that exposes the app's in-process tools to an external
 *  agent runtime such as DSH.
 *
 *  Claude Agent SDK can host MCP servers in-process; DSH cannot. The DSH
 *  profile therefore launches `scripts/pet-mcp-bridge.cjs` as a stdio MCP
 *  server, and that process forwards each call to this loopback-only HTTP
 *  endpoint. The token is generated per app launch and never written to disk.
 *
 *  Tool names deliberately mirror the existing MCP tools
 *  (`conversations.list`, `deepseek.search`, ...) so prompts, documentation
 *  and the fallback Claude kernel keep the same vocabulary. DSH prefixes them
 *  with `mcp__pet__`.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { ConversationBridge } from './conversation-tools'
import type { EvolveBridge } from './evolve-tools'
import { deepseekFetch, deepseekSearch } from './deepseek-tools'
import { appendMemoryNote } from './memory-document'

export interface PetMcpToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface PetMcpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const MAX_BODY_BYTES = 1_000_000

/** Definitions are shared with the stdio script through `PET_MCP_TOOLS` in
 *  `scripts/pet-mcp-bridge.cjs`; `test/pet-mcp-bridge.test.ts` pins the names. */
export const PET_MCP_TOOLS: PetMcpToolDefinition[] = [
  {
    name: 'conversations_list',
    description: '列出本应用里的其他对话及其运行状态。仅在需要给另一个对话转达消息时使用；返回 id、标题、是否正在运行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'conversations_send_message',
    description: '向本应用里的另一个对话发送一条消息。仅在用户明确要求转达时使用；对方会像收到用户消息一样处理，可能触发它的模型回复并产生费用。target 用清单里的 id 或唯一标题。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标对话的 id 或唯一标题' },
        message: { type: 'string', description: '要转达的正文，最多 8000 字' }
      },
      required: ['target', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'evolve_schedule',
    description: '安排重启后继续执行的一步：prompt 是重启后发给本对话的指令，command 是重启后在本机执行的命令，goal 是要跨重启保留的目标条件。可以同时给多项。只在用户要求自我更新、并已切到「自我进化」模式时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '重启后要继续的目标条件；会重新发送 /goal' },
        prompt: { type: 'string', description: '重启后发给本对话的指令' },
        command: { type: 'string', description: '重启后在应用工作目录执行的 shell 命令' },
        note: { type: 'string', description: '写进任务备注的说明' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'evolve_status',
    description: '读取当前自我进化任务：状态、目标、待执行步骤和已执行结果。只在「自我进化」模式下可用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'evolve_restart',
    description: '保存当前自我进化任务并重启应用。等当前回合结束后执行；可以传 version 切到已经打包好的 release 版本（例如 0.0.88）。自我更新前先运行 npm run pack:release 生成新版本，再传版本号。只在用户明确要求自我更新、并已切到「自我进化」模式时使用。重启/切换版本必须走这个工具；禁止用 Stop-Process、taskkill 等外部命令强杀应用，那会连同工具子进程一起终止，应用不会被拉起。',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: '要启动的发布版本号，例如 0.0.88；不传则重启当前版本' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'request_approval',
    description: '在角色旁弹出一个小批准卡（绿勾批准、红叉拒绝），用于打包、重启、自我更新这类必须先征得用户同意的操作。返回 approved:true/false；超时返回 approved:null。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话说明要批准什么' },
        detail: { type: 'string', description: '补充说明，最多 300 字' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'deepseek_search',
    description: '用 DeepSeek 自研搜索引擎搜索网页。返回标题、链接与摘要；需要全文时再用 deepseek_fetch 抓取对应链接。支持 site:、lang:、after: 等搜索操作符。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        count: { type: 'number', description: '返回条数，1-10，默认 6' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'deepseek_fetch',
    description: '抓取一个网页并返回 Markdown 正文。由 DeepSeek 服务端抓取，不受本机网络与客户端域名校验影响。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 HTTP/HTTPS 网址' } },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    name: 'memory_remember',
    description: '把主人明确要求长期记住的一条约定追加到 data/memory/MEMORY.md；写进去之后每一轮对话（包括新开的对话）都会读到。只在主人说「记住」「以后都这样」「别再」这类长期要求时使用；踩过的坑、验证结论这类临时记录不要写这里，写 data/memory/NOTES.md。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要长期记住的一条约定，写成一句完整的话，最多 400 字' }
      },
      required: ['text'],
      additionalProperties: false
    }
  }
]

function ok(payload: unknown): PetMcpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(message: string): PetMcpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export interface ApprovalBridge {
  request(title: string, detail?: string): Promise<boolean | null>
}

export class PetMcpBridge {
  private server: Server | undefined
  private startPromise: Promise<{ url: string; token: string }> | undefined
  private conversationBridge: ConversationBridge | undefined
  private evolveBridge: EvolveBridge | undefined
  private approvalBridge: ApprovalBridge | undefined
  private deepseekKey: string | undefined
  /** 联网搜索开关：关闭时搜索/抓取工具不再声明，调用也会被拒绝。 */
  webSearchEnabled = true
  readonly token = randomBytes(24).toString('hex')

  constructor(private readonly deepseekApiKey?: string) {
    this.deepseekKey = deepseekApiKey?.trim() || undefined
  }

  get endpoint(): { url: string; token: string } | null {
    const address = this.server?.address()
    if (!address || typeof address === 'string') return null
    return { url: `http://127.0.0.1:${address.port}`, token: this.token }
  }

  setConversationBridge(bridge?: ConversationBridge): void {
    this.conversationBridge = bridge
  }

  setEvolveBridge(bridge?: EvolveBridge): void {
    this.evolveBridge = bridge
  }

  setApprovalBridge(bridge?: ApprovalBridge): void {
    this.approvalBridge = bridge
  }

  setDeepSeekApiKey(key?: string): void {
    this.deepseekKey = key?.trim() || undefined
  }

  start(): Promise<{ url: string; token: string }> {
    const endpoint = this.endpoint
    if (endpoint) return Promise.resolve(endpoint)
    if (!this.startPromise) {
      this.startPromise = new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
          void this.handle(request, response)
        })
        server.once('error', (error) => {
          this.startPromise = undefined
          reject(error)
        })
        server.listen(0, '127.0.0.1', () => {
          this.server = server
          const address = server.address()
          if (!address || typeof address === 'string') {
            server.close()
            this.startPromise = undefined
            reject(new Error('MCP bridge 没有拿到端口。'))
            return
          }
          resolve({ url: `http://127.0.0.1:${address.port}`, token: this.token })
        })
      })
    }
    return this.startPromise
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = undefined
    this.startPromise = undefined
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      const payload = JSON.stringify(body)
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
        'cache-control': 'no-store'
      })
      response.end(payload)
    }
    if (request.method !== 'POST' || request.url !== '/call') {
      reply(404, { error: 'not found' })
      return
    }
    if (request.headers['x-pet-bridge-token'] !== this.token) {
      reply(401, { error: 'unauthorized' })
      return
    }
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        reply(413, { error: 'body too large' })
        return
      }
      chunks.push(buffer)
    }
    let body: { tool?: unknown; args?: unknown }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool?: unknown; args?: unknown }
    } catch {
      reply(400, { error: 'invalid json' })
      return
    }
    const tool = text(body.tool)
    if (!PET_MCP_TOOLS.some((definition) => definition.name === tool)) {
      reply(400, { error: `unknown tool: ${tool}` })
      return
    }
    if (!this.webSearchEnabled && tool.startsWith('deepseek_')) {
      reply(200, fail('联网搜索已关闭。不要尝试搜索或抓取，直接基于已有信息回答。'))
      return
    }
    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? body.args as Record<string, unknown>
      : {}
    try {
      reply(200, await this.call(tool, args))
    } catch (error) {
      reply(200, fail(error instanceof Error ? error.message : '工具调用失败。'))
    }
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<PetMcpToolResult> {
    if (tool === 'request_approval') {
      const title = text(args.title).trim()
      if (!title) return fail('批准事项不能为空。')
      if (!this.approvalBridge) return fail('批准通道尚未就绪。')
      const approved = await this.approvalBridge.request(title, text(args.detail).trim() || undefined)
      return ok({ approved })
    }
    if (tool === 'conversations_list') {
      if (!this.conversationBridge) return fail('对话通道尚未就绪。')
      return ok({
        conversations: this.conversationBridge.list()
          .filter((target) => !target.archived)
          .map((target) => ({ id: target.id, title: target.title, running: target.running }))
      })
    }
    if (tool === 'conversations_send_message') {
      if (!this.conversationBridge) return fail('对话通道尚未就绪。')
      const target = text(args.target).trim()
      const message = text(args.message).trim()
      if (!target) return fail('缺少目标对话。')
      if (!message) return fail('消息不能为空。')
      if (message.length > 8_000) return fail('消息超过 8000 字，请缩短。')
      const delivered = await this.conversationBridge.send(target, message)
      return ok({ delivered: true, conversationId: delivered.id, title: delivered.title })
    }
    if (tool.startsWith('evolve_')) {
      const bridge = this.evolveBridge
      if (!bridge) return fail('自我进化通道尚未就绪。')
      if (!bridge.enabled()) return fail('只有「自我进化」审批模式可以使用这个工具。请让用户先在审批菜单里切换模式。')
      if (tool === 'evolve_schedule') {
        return ok(await bridge.schedule({
          goal: text(args.goal) || undefined,
          prompt: text(args.prompt) || undefined,
          command: text(args.command) || undefined,
          note: text(args.note) || undefined
        }))
      }
      if (tool === 'evolve_status') return ok(await bridge.status())
      if (tool === 'evolve_restart') {
        const version = text(args.version).trim()
        if (version && !/^\d+\.\d+\.\d+$/.test(version)) return fail('版本号应形如 0.0.88。')
        return ok(await bridge.restart(version || undefined))
      }
      return fail(`未知工具：${tool}`)
    }
    if (tool === 'memory_remember') {
      const result = appendMemoryNote(text(args.text))
      if (!result.added) return fail(result.reason ?? '没有写入长期记忆。')
      return ok({ saved: true, file: result.file })
    }
    if (tool === 'deepseek_search') {
      if (!this.deepseekKey) return fail('DeepSeek API Key 尚未配置。')
      const query = text(args.query).trim()
      if (!query) return fail('搜索词不能为空。')
      const count = typeof args.count === 'number' ? args.count : 6
      const hits = await deepseekSearch(query, count, this.deepseekKey)
      return hits.length ? ok({ results: hits }) : ok({ results: [], note: '没有找到相关结果。' })
    }
    if (tool === 'deepseek_fetch') {
      if (!this.deepseekKey) return fail('DeepSeek API Key 尚未配置。')
      const url = text(args.url).trim()
      if (!/^https?:\/\//i.test(url)) return fail('需要一个 HTTP/HTTPS 网址。')
      return ok(await deepseekFetch(url, this.deepseekKey))
    }
    return fail(`未知工具：${tool}`)
  }
}
