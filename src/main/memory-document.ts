/** 长期记忆文档：`data/memory/MEMORY.md`。
 *
 *  和 `memory-service.ts` 的 facts.json 分工不同：那里是模型从主人原话里
 *  自动抽出来的零散事实，这里是主人亲手写下的长期约定，每一轮都原样交给
 *  模型，优先级更高。DSH 内核不接受宿主注入的系统提示（`DSH_SYSTEM_PROMPT`
 *  没有消费者），所以这段文字跟着用户消息一起送进去——这一条通道是验证过
 *  能到达模型的。
 *
 *  文件由主人直接编辑，助手只能通过 `mcp__pet__memory_remember` 追加；读盘
 *  按 mtime + size 缓存，改完下一轮就生效。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 首次启动写入的骨架。之后这个文件就是主人的，不再覆盖。 */
export const MEMORY_DOCUMENT_SEED = `# 小鲸的长期记忆

<!-- 这里放长期有效的约定；每一轮都会整份交给小鲸，新开的对话也一样。
     主人可以直接改这个文件，保存后下一轮生效。 -->

## 必须遵守

## 追加记录
`

/** 注入上限：再长就会挤占每一轮的上下文。 */
const MAX_BLOCK_CHARS = 6_000
/** 追加只接受短句；过长的内容应该由主人自己整理进文件。 */
const MAX_NOTE_CHARS = 400
/** 文件写满后拒绝追加，交给主人清理。 */
const MAX_DOCUMENT_CHARS = 24_000

let documentPath: string | null = null
let cached: { key: string; text: string } | null = null

/** 配置记忆文件位置；传 null 关闭读取（测试和库用法）。 */
export function setMemoryDocumentPath(file: string | null): void {
  documentPath = file ? path.resolve(file) : null
  cached = null
}

export function memoryDocumentPath(): string | null {
  return documentPath
}

/** 在数据目录下物化 `memory/MEMORY.md`，并把位置配置好。已有文件不碰。 */
export function seedMemoryDocument(dataRoot: string): string {
  const file = path.join(path.resolve(dataRoot), 'memory', 'MEMORY.md')
  setMemoryDocumentPath(file)
  try {
    if (!existsSync(file)) {
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, MEMORY_DOCUMENT_SEED, 'utf8')
    }
  } catch {
    // 写不出来也不影响启动：读取会返回空。
  }
  return file
}

function readFileCached(file: string): string {
  let key: string
  try {
    const stat = statSync(file)
    key = `${stat.mtimeMs}:${stat.size}`
  } catch {
    cached = null
    return ''
  }
  if (cached?.key === key) return cached.text
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return ''
  }
  cached = { key, text }
  return text
}

/** 文件原文；没有配置、文件不存在或只有空白时返回空串。 */
export function readMemoryDocument(): string {
  if (!documentPath) return ''
  return readFileCached(documentPath).trim()
}

/** 去掉注释和标题后还剩内容吗——只有骨架的文件不值得每轮都注入。 */
function hasBody(text: string): boolean {
  return text
    .replace(/<!--[\s\S]*?-->/gu, '')
    .split(/\r?\n/u)
    .some((line) => line.trim() && !line.trim().startsWith('#'))
}

/**
 * 交给模型的整段文字。放在用户消息最前面，措辞按硬性要求写：这不是
 * 参考背景，主人明确改变之前必须照做。
 */
export function memoryDocumentBlock(): string {
  const text = readMemoryDocument()
  if (!text || !hasBody(text)) return ''
  const body = text.length > MAX_BLOCK_CHARS
    ? `${text.slice(0, MAX_BLOCK_CHARS)}\n…（记忆文件过长，已截断；请主人精简）`
    : text
  return [
    '## 长期记忆（主人写下的约定）',
    '下面这些是主人长期有效的硬性要求，对所有对话生效，包括新开的对话。',
    '除非主人在本轮明确改变，否则必须照做，不要等主人重复提醒。',
    '',
    body
  ].join('\n')
}

function noteKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[\s.,!?，。！？；;：:、"'“”‘’()（）[\]【】]/gu, '')
}

function cleanNote(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, ' ')
    .replace(/\r?\n+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

export interface MemoryAppendResult {
  added: boolean
  /** 拒绝或去重的原因，直接回给模型。 */
  reason?: string
  file?: string
}

/** 追加一条约定到文件末尾。只追加、不改写；重复内容会被拒绝。 */
export function appendMemoryNote(value: string): MemoryAppendResult {
  if (!documentPath) return { added: false, reason: '记忆文件尚未配置。' }
  const note = cleanNote(value)
  if (!note) return { added: false, reason: '内容为空。' }
  if (note.length > MAX_NOTE_CHARS) return { added: false, reason: `一条记忆最多 ${MAX_NOTE_CHARS} 字，请拆开或精简。` }
  const existing = readFileCached(documentPath)
  if (noteKey(existing).includes(noteKey(note))) {
    return { added: false, reason: '这条已经记过了。', file: documentPath }
  }
  if (existing.length + note.length > MAX_DOCUMENT_CHARS) {
    return { added: false, reason: '记忆文件太长，请主人先精简再追加。', file: documentPath }
  }
  const current = existing.trimEnd()
  const next = `${current}${current ? '\n' : ''}- ${note}\n`
  const temporary = `${documentPath}.${process.pid}.tmp`
  try {
    mkdirSync(path.dirname(documentPath), { recursive: true })
    writeFileSync(temporary, next, 'utf8')
    renameSync(temporary, documentPath)
  } catch (error) {
    try { unlinkSync(temporary) } catch { /* 临时文件可能没写出来 */ }
    const message = error instanceof Error ? error.message : String(error)
    return { added: false, reason: `写入记忆文件失败：${message}` }
  }
  cached = null
  return { added: true, file: documentPath }
}
