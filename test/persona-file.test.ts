import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPersona, setPersonaDirectory } from '../src/main/persona'

const created: string[] = []

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-persona-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  setPersonaDirectory(null)
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true })
})

describe('persona files', () => {
  it('reads data/persona/<id>.md and substitutes placeholders', () => {
    const dir = makeDir()
    writeFileSync(path.join(dir, 'xiaojing.md'), '你是{{name}}，称呼他{{address}}。\n', 'utf8')
    setPersonaDirectory(dir)
    expect(buildPersona('xiaojing', { userAddress: '老板', assistantName: '阿鲸' })).toBe('你是阿鲸，称呼他老板。')
  })

  it('falls back to the built-in preset when the file is missing', () => {
    setPersonaDirectory(makeDir())
    expect(buildPersona('xiaojing')).toContain('你叫小鲸')
  })

  it('ignores an empty persona file', () => {
    const dir = makeDir()
    writeFileSync(path.join(dir, 'xiaojing.md'), '   \n', 'utf8')
    setPersonaDirectory(dir)
    expect(buildPersona('xiaojing')).toContain('你叫小鲸')
  })

  it('keeps built-in behavior when no directory is configured', () => {
    expect(buildPersona('rin')).toContain('远坂凛')
  })
})
