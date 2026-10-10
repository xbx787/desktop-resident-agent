import { toolIconKind } from './tool-icons'

export interface DiffStat {
  added: number
  removed: number
}

export type DiffLineKind = 'add' | 'del' | 'context' | 'gap'

export interface DiffLine {
  kind: DiffLineKind
  text: string
}

export interface DiffPreview extends DiffStat {
  lines: DiffLine[]
  /** Lines dropped by the render limit; the counts above still describe the whole change. */
  hidden: number
}

/** Past this many cells the table is skipped and the diff just shows the whole block. */
const MAX_CELLS = 250_000
/** Rendered lines per tool row: enough to read a real edit, bounded for a whole-file write. */
const PREVIEW_LINES = 200

function toLines(text: string | undefined): string[] {
  if (!text) return []
  const normalized = text.replace(/\r\n/g, '\n').replace(/\n$/, '')
  return normalized ? normalized.split('\n') : []
}

/**
 * Line-by-line diff: the LCS table is walked forward to emit context, removed and
 * added lines in file order. Oversized blocks fall back to "everything removed,
 * everything added" — slower to read, but never a stall and never a wrong count.
 */
function diffSequence(before: string[], after: string[]): DiffLine[] {
  const rows = before.length
  const columns = after.length
  if (!rows || !columns || rows * columns > MAX_CELLS) {
    return [
      ...before.map((text): DiffLine => ({ kind: 'del', text })),
      ...after.map((text): DiffLine => ({ kind: 'add', text }))
    ]
  }
  const width = columns + 1
  const table = new Uint32Array((rows + 1) * width)
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      table[row * width + column] = before[row] === after[column]
        ? table[(row + 1) * width + column + 1] + 1
        : Math.max(table[(row + 1) * width + column], table[row * width + column + 1])
    }
  }
  const lines: DiffLine[] = []
  let row = 0
  let column = 0
  while (row < rows && column < columns) {
    if (before[row] === after[column]) {
      lines.push({ kind: 'context', text: before[row] })
      row += 1
      column += 1
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      lines.push({ kind: 'del', text: before[row] })
      row += 1
    } else {
      lines.push({ kind: 'add', text: after[column] })
      column += 1
    }
  }
  for (; row < rows; row += 1) lines.push({ kind: 'del', text: before[row] })
  for (; column < columns; column += 1) lines.push({ kind: 'add', text: after[column] })
  return lines
}

function editLines(record: Record<string, unknown>): DiffLine[] | null {
  const edits = Array.isArray(record.edits) ? record.edits : null
  if (edits) {
    const blocks: DiffLine[][] = []
    for (const item of edits) {
      if (!item || typeof item !== 'object') continue
      const edit = item as Record<string, unknown>
      const oldText = typeof edit.old_string === 'string' ? edit.old_string : undefined
      const newText = typeof edit.new_string === 'string' ? edit.new_string : undefined
      if (oldText === undefined && newText === undefined) continue
      blocks.push(diffSequence(toLines(oldText ?? ''), toLines(newText ?? '')))
    }
    if (!blocks.length) return null
    // One call can carry several edits to the same file; a separator keeps their
    // changes from reading as one continuous block.
    const lines: DiffLine[] = []
    blocks.forEach((block, index) => {
      if (index) lines.push({ kind: 'gap', text: '⋯' })
      lines.push(...block)
    })
    return lines
  }
  const oldText = typeof record.old_string === 'string' ? record.old_string : undefined
  const newText = typeof record.new_string === 'string' ? record.new_string : undefined
  if (oldText === undefined && newText === undefined) return null
  return diffSequence(toLines(oldText ?? ''), toLines(newText ?? ''))
}

/** A whole-file write has no "before" to compare against, so every line reads as added. */
function writtenLines(record: Record<string, unknown>, key: string): DiffLine[] | null {
  const text = typeof record[key] === 'string' ? (record[key] as string) : undefined
  if (text === undefined) return null
  return toLines(text).map((line): DiffLine => ({ kind: 'add', text: line }))
}

function changeLines(name: string, input: string | undefined): DiffLine[] | null {
  const trimmed = input?.trim()
  if (!trimmed) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  let lines: DiffLine[] | null = null
  switch (toolIconKind(name)) {
    case 'pencil':
      lines = editLines(record)
      break
    case 'document-write':
      lines = writtenLines(record, 'content')
      break
    case 'notebook':
      lines = writtenLines(record, 'new_source')
      break
    default:
      lines = null
  }
  return lines?.length ? lines : null
}

/** Context goes first: what survives a long diff should be the lines that changed. */
function trim(lines: DiffLine[], limit: number): { lines: DiffLine[]; hidden: number } {
  if (lines.length <= limit) return { lines, hidden: 0 }
  const kept = lines.filter((line) => line.kind !== 'context').slice(0, limit)
  return { lines: kept, hidden: lines.length - kept.length }
}

/**
 * The change a writing tool is about to make (or has made), derived from the call's
 * own arguments: added and removed line counts plus the lines themselves, in file
 * order, ready to render as a diff.
 */
export function toolDiffPreview(name: string, input: string | undefined, limit = PREVIEW_LINES): DiffPreview | null {
  const lines = changeLines(name, input)
  if (!lines) return null
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.kind === 'add') added += 1
    else if (line.kind === 'del') removed += 1
  }
  const kept = trim(lines, Math.max(1, limit))
  return { added, removed, lines: kept.lines, hidden: kept.hidden }
}
