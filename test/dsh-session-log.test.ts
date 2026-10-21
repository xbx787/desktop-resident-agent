import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { findDshSessionLog, readDshSessionUsage, subtractUsage } from '../src/main/dsh-session-log'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whale-dsh-log-'))
  roots.push(dir)
  return dir
}

function event(type: string, data: Record<string, unknown>): string {
  return `${JSON.stringify({ type, data })}\n`
}

describe('readDshSessionUsage', () => {
  it('sums usage across independently compressed zstd frames', () => {
    const file = path.join(temp(), 'session.v4.jsonl.zstd')
    const lines = [
      event('session', { id: 's' }),
      event('assistant/message', { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
      event('assistant/message', {
        usage: { inputTokens: 50, outputTokens: 10, cacheReadTokens: 5, cacheWriteTokens: 2, totalTokens: 67 }
      })
    ]
    writeFileSync(file, Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(line, 'utf8')))))
    expect(readDshSessionUsage(file)).toEqual({
      input: 150, output: 30, cacheRead: 5, cacheWrite: 2, total: 187
    })
  })

  it('reads an uncompressed JSONL log as well', () => {
    const file = path.join(temp(), 'session.v4.jsonl')
    writeFileSync(file, [
      event('assistant/message', { usage: { inputTokens: 7, outputTokens: 3 } }),
      event('turn/end', {})
    ].join(''))
    expect(readDshSessionUsage(file)).toEqual({
      input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10
    })
  })

  it('returns zeros for a missing or corrupt file', () => {
    const file = path.join(temp(), 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.from('not zstd at all'))
    expect(readDshSessionUsage(file)).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0
    })
    expect(readDshSessionUsage(path.join(temp(), 'missing'))).toEqual({
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0
    })
  })
})

describe('findDshSessionLog', () => {
  it('finds the per-session directory under an encoded cwd', () => {
    const home = temp()
    const directory = path.join(home, 'sessions', '--D-DesktopPetProject--', 'session-1')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, 'session.v4.jsonl.zstd')
    writeFileSync(file, Buffer.from(''))
    expect(findDshSessionLog(home, 'session-1')).toBe(file)
    expect(findDshSessionLog(home, 'session-2')).toBeNull()
  })
})

describe('subtractUsage', () => {
  it('never goes negative when a log is rewritten', () => {
    expect(subtractUsage(
      { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
      { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, total: 30 }
    )).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })
  })
})
