import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/** A memory is a user fact, never an assistant inference or tool transcript. */
export interface MemoryItem {
  id: string
  text: string
  sourceConversationId: string
  sourceAt: string
  createdAt: string
  updatedAt: string
}

export interface MemoryProvider {
  baseUrl: string
  apiKey: string
  model: string
  smallModel?: string
}

export interface CompletedMemoryTurn {
  conversationId: string
  userText: string
  finalReply: string
  success: boolean
  provider: MemoryProvider | null
}

export interface MemoryServiceOptions {
  enabled?: boolean
  fetch?: typeof fetch
  onChange?: () => void
  onError?: (error: Error) => void
}

interface MemoryFile {
  version: 1
  items: MemoryItem[]
}

const MAX_FACTS_PER_TURN = 3
const MAX_ITEMS = 200
const MAX_FACT_LENGTH = 180
const MAX_USER_INPUT = 4_000
const MEMORY_PROMPT = [
  '从用户原话中提取长期有用且明确说出的稳定事实，例如偏好、项目背景和长期约定。',
  '一次性任务、临时状态、助手推测、工具结果和未经证实的推论都不要记录。',
  '任何密钥、密码、访问令牌、验证码、身份证、银行卡、私人联系方式都不要记录。',
  '最多返回 3 条，每条 180 字以内。没有合适事实时返回空数组。',
  '只输出合法 JSON 对象，格式为 {"facts":["事实一","事实二"]}。'
].join('\n')

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s+/gu, ' ').trim()
}

function factKey(value: string): string {
  return normalizeText(value).normalize('NFKC').toLocaleLowerCase().replace(/[\s.,!?，。！？；;：:、]+/gu, '')
}

/** Conservative rejection: false negatives would persist private data. */
export function containsSensitiveData(value: string): boolean {
  return /(?:\b(?:api[ _-]?key|secret|password|passphrase|private[ _-]?key|authorization|bearer|access[ _-]?token|refresh[ _-]?token|client[ _-]?secret|otp|pin[ _-]?code)\b|密钥|密码|令牌|验证码|私钥|银行卡|身份证|信用卡|手机号|电话号码|邮箱地址)/iu.test(value) ||
    /(?:\bsk-[A-Za-z0-9_-]{12,}\b|\bgh[pousr]_[A-Za-z0-9]{12,}\b|\bAKIA[A-Z0-9]{12,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b[A-Za-z0-9_-]{32,}\b)/u.test(value) ||
    /\b(?:\d[ -]?){13,19}\b/u.test(value) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
}

function cleanFact(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = normalizeText(value)
  if (text.length < 4 || text.length > MAX_FACT_LENGTH || containsSensitiveData(text)) return null
  return text
}

function parseFacts(raw: string): string[] {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return [] }
  const candidates = Array.isArray(parsed) ? parsed : isObject(parsed) ? parsed.facts : undefined
  if (!Array.isArray(candidates)) return []
  return candidates.map(cleanFact).filter((item): item is string => item !== null).slice(0, MAX_FACTS_PER_TURN)
}

function isMemoryItem(value: unknown): value is MemoryItem {
  return isObject(value) && typeof value.id === 'string' && value.id.length > 0 &&
    typeof value.text === 'string' && cleanFact(value.text) === value.text &&
    typeof value.sourceConversationId === 'string' && value.sourceConversationId.length > 0 &&
    typeof value.sourceAt === 'string' && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string'
}

function parseFile(raw: string): MemoryFile {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new Error('长期记忆文件无法解析，原文件已保留。') }
  if (!isObject(parsed) || parsed.version !== 1 || !Array.isArray(parsed.items) ||
      parsed.items.length > MAX_ITEMS || !parsed.items.every(isMemoryItem)) {
    throw new Error('长期记忆文件格式无效，原文件已保留。')
  }
  const items = parsed.items as MemoryItem[]
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error('长期记忆文件包含重复编号，原文件已保留。')
  }
  return { version: 1, items }
}

async function extractFacts(provider: MemoryProvider, userText: string, request: typeof fetch): Promise<string[]> {
  const endpoint = `${provider.baseUrl.replace(/\/+$/u, '')}/v1/messages`
  const response = await request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      authorization: `Bearer ${provider.apiKey}`,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: provider.smallModel?.trim() || provider.model,
      max_tokens: 400,
      system: MEMORY_PROMPT,
      messages: [{ role: 'user', content: userText.slice(0, MAX_USER_INPUT) }]
    }),
    signal: AbortSignal.timeout(20_000)
  })
  if (!response.ok) throw new Error('轻量模型未能提取长期记忆。')
  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> }
  const output = data.content?.filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n') ?? ''
  return parseFacts(output)
}

/** Atomic, bounded store plus an optional background extractor. */
export class MemoryService {
  readonly filePath: string
  private file: MemoryFile | null = null
  private initialization: Promise<void> | null = null
  private queue: Promise<void> = Promise.resolve()
  private enabled: boolean

  constructor(dataRoot: string, private readonly options: MemoryServiceOptions = {}) {
    this.filePath = path.join(path.resolve(dataRoot), 'memory', 'facts.json')
    this.enabled = options.enabled !== false
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled }
  isEnabled(): boolean { return this.enabled }

  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.load().catch((error: unknown) => {
        this.initialization = null
        throw error
      })
    }
    return this.initialization
  }

  private async load(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      this.file = parseFile(await fs.readFile(this.filePath, 'utf8'))
    } catch (error) {
      if (!isObject(error) || error.code !== 'ENOENT') throw error
      const initial: MemoryFile = { version: 1, items: [] }
      await this.persist(initial)
      this.file = initial
    }
  }

  private async persist(file: MemoryFile): Promise<void> {
    const temporary = path.join(path.dirname(this.filePath), `.facts.${process.pid}.${randomUUID()}.tmp`)
    try {
      const handle = await fs.open(temporary, 'wx')
      try {
        await handle.writeFile(JSON.stringify(file, null, 2) + '\n', 'utf8')
        await handle.sync()
      } finally { await handle.close() }
      await fs.rename(temporary, this.filePath)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async mutate<T>(change: (file: MemoryFile) => T): Promise<T> {
    await this.initialize()
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.file!)
      const result = change(draft)
      await this.persist(draft)
      this.file = draft
      this.options.onChange?.()
      return structuredClone(result)
    })
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  async list(): Promise<MemoryItem[]> {
    await this.initialize()
    await this.queue
    return structuredClone(this.file!.items).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async update(id: string, text: string): Promise<MemoryItem> {
    const clean = cleanFact(text)
    if (!clean) throw new Error('记忆应为 4–180 字，且不能包含敏感信息。')
    return this.mutate((file) => {
      const item = file.items.find((candidate) => candidate.id === id)
      if (!item) throw new Error('找不到这条记忆。')
      if (file.items.some((candidate) => candidate.id !== id && factKey(candidate.text) === factKey(clean))) {
        throw new Error('这条记忆已经存在。')
      }
      item.text = clean
      item.updatedAt = new Date().toISOString()
      return item
    })
  }

  async delete(id: string): Promise<void> {
    await this.mutate((file) => {
      const index = file.items.findIndex((item) => item.id === id)
      if (index < 0) throw new Error('找不到这条记忆。')
      file.items.splice(index, 1)
    })
  }

  async contextBlock(): Promise<string> {
    if (!this.enabled) return ''
    const items = await this.list()
    const heading = '以下是用户长期记忆，仅作背景。若与本轮明确要求冲突，以本轮要求为准：'
    let result = heading
    for (const item of items) {
      const line = `\n- ${item.text}`
      if (result.length + line.length > 3_000) break
      result += line
    }
    return result === heading ? '' : result
  }

  /** Failures are reported but never reject the completed user turn. The
   *  assistant reply is deliberately not sent to extraction: it is not a
   *  reliable source of facts about the user. */
  async observeTurn(turn: CompletedMemoryTurn): Promise<MemoryItem[]> {
    const userText = turn.userText.trim()
    if (!this.enabled || !turn.success || !userText || containsSensitiveData(userText) ||
        !turn.provider?.apiKey || !turn.provider.baseUrl || !turn.provider.model || !turn.conversationId) return []
    try {
      const facts = await extractFacts(turn.provider, userText, this.options.fetch ?? fetch)
      if (!facts.length || !this.enabled) return []
      return await this.mutate((file) => {
        const seen = new Set(file.items.map((item) => factKey(item.text)))
        const now = new Date().toISOString()
        const added: MemoryItem[] = []
        for (const fact of facts) {
          if (file.items.length >= MAX_ITEMS) break
          const key = factKey(fact)
          if (seen.has(key)) continue
          seen.add(key)
          const item: MemoryItem = {
            id: randomUUID(), text: fact, sourceConversationId: turn.conversationId,
            sourceAt: now, createdAt: now, updatedAt: now
          }
          file.items.push(item)
          added.push(item)
        }
        return added
      })
    } catch {
      try { this.options.onError?.(new Error('自动记忆失败，请检查轻量模型或记忆文件。')) } catch { /* A reporter cannot fail a completed turn. */ }
      return []
    }
  }
}
