/** Reads token accounting out of a DSH session log.
 *
 *  ACP does not expose per-turn input/output tokens; DSH writes them to its
 *  durable session log as `assistant/message.data.usage`. The default log is a
 *  sequence of independently compressed Zstandard frames, one per append
 *  batch, so a single `zstdDecompressSync` call only returns the first frame.
 *  This module walks the frame headers without external dependencies and
 *  decompresses each frame in order.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528
const MAX_LOG_BYTES = 64 * 1024 * 1024

export interface DshSessionUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

const EMPTY_USAGE: DshSessionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }

/** Length of one complete Zstandard frame starting at `offset`, or -1. */
function frameLength(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return -1
  let position = offset + 4
  if (position >= buffer.length) return -1
  const descriptor = buffer[position++]
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor >>> 5) & 1
  const checksum = (descriptor >>> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (!singleSegment) position += 1
  position += [0, 1, 2, 4][dictionaryFlag]
  position += [singleSegment ? 1 : 0, 2, 4, 8][contentSizeFlag]
  if (position + 3 > buffer.length) return -1
  // Each block header is three little-endian bytes: last(1) + type(2) + size(21).
  for (;;) {
    if (position + 3 > buffer.length) return -1
    const header = buffer.readUIntLE(position, 3)
    position += 3
    const last = header & 1
    const type = (header >>> 1) & 3
    const size = header >>> 3
    if (type === 1) position += 1 // RLE block
    else if (type === 0 || type === 2) position += size // raw or compressed
    else return -1 // reserved
    if (last) break
    if (position > buffer.length) return -1
  }
  if (checksum) position += 4
  return position > buffer.length ? -1 : position - offset
}

function decodeLog(buffer: Buffer): string {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) {
    return buffer.toString('utf8')
  }
  const parts: string[] = []
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === ZSTD_MAGIC) {
    const length = frameLength(buffer, offset)
    if (length <= 0 || offset + length > buffer.length) break
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset, offset + length)).toString('utf8'))
    } catch {
      break
    }
    offset += length
  }
  return parts.join('')
}

export function readDshSessionUsage(file: string): DshSessionUsage {
  let buffer: Buffer
  try {
    buffer = readFileSync(file)
    if (buffer.length > MAX_LOG_BYTES) return { ...EMPTY_USAGE }
  } catch {
    return { ...EMPTY_USAGE }
  }
  const usage: DshSessionUsage = { ...EMPTY_USAGE }
  for (const line of decodeLog(buffer).split(/\r?\n/u)) {
    if (!line.trim()) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type !== 'assistant/message') continue
    const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
      ? event.data as Record<string, unknown> : {}
    const raw = data.usage
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const value = raw as Record<string, unknown>
    const number = (key: string): number => typeof value[key] === 'number' && Number.isFinite(value[key])
      ? Number(value[key]) : 0
    const input = number('inputTokens')
    const output = number('outputTokens')
    const cacheRead = number('cacheReadTokens')
    const cacheWrite = number('cacheWriteTokens')
    const total = number('totalTokens') || input + output + cacheRead + cacheWrite
    usage.input += input
    usage.output += output
    usage.cacheRead += cacheRead
    usage.cacheWrite += cacheWrite
    usage.total += total
  }
  return usage
}

/** Finds `<DSH_HOME>/sessions/<encoded-cwd>/<sessionId>/session.v4.jsonl*`. */
export function findDshSessionLog(dshHome: string, sessionId: string): string | null {
  if (!sessionId) return null
  const root = path.join(dshHome, 'sessions')
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const directory = path.join(root, entry.name, sessionId)
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl']) {
        const file = path.join(directory, name)
        if (existsSync(file)) return file
      }
    }
  } catch {
    // No session log yet.
  }
  return null
}

export function subtractUsage(current: DshSessionUsage, previous: DshSessionUsage): DshSessionUsage {
  return {
    input: Math.max(0, current.input - previous.input),
    output: Math.max(0, current.output - previous.output),
    cacheRead: Math.max(0, current.cacheRead - previous.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - previous.cacheWrite),
    total: Math.max(0, current.total - previous.total)
  }
}
