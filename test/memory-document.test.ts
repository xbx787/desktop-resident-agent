import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MEMORY_DOCUMENT_SEED,
  appendMemoryNote,
  memoryDocumentBlock,
  memoryDocumentPath,
  readMemoryDocument,
  seedMemoryDocument,
  setMemoryDocumentPath
} from '../src/main/memory-document'

const roots: string[] = []

function dataRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-memory-doc-'))
  roots.push(root)
  return root
}

afterEach(() => {
  setMemoryDocumentPath(null)
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true })
})

describe('memory document', () => {
  it('seeds data/memory/MEMORY.md once and never overwrites it', () => {
    const root = dataRoot()
    const file = seedMemoryDocument(root)
    expect(file).toBe(path.join(root, 'memory', 'MEMORY.md'))
    expect(memoryDocumentPath()).toBe(file)
    expect(readFileSync(file, 'utf8')).toBe(MEMORY_DOCUMENT_SEED)

    writeFileSync(file, '# 小鲸的长期记忆\n\n## 必须遵守\n- 不要擅自打包或重启。\n', 'utf8')
    seedMemoryDocument(root)
    expect(readMemoryDocument()).toContain('不要擅自打包或重启')
  })

  it('does not inject a file that only has the skeleton', () => {
    seedMemoryDocument(dataRoot())
    expect(readMemoryDocument()).toContain('# 小鲸的长期记忆')
    expect(memoryDocumentBlock()).toBe('')
  })

  it('injects rules as hard requirements, ahead of background facts', () => {
    const root = dataRoot()
    const file = path.join(root, 'memory', 'MEMORY.md')
    seedMemoryDocument(root)
    writeFileSync(file, '# 小鲸的长期记忆\n\n## 必须遵守\n- 不要擅自打包或重启。\n', 'utf8')

    const block = memoryDocumentBlock()
    expect(block).toContain('长期记忆')
    expect(block).toContain('对所有对话生效')
    expect(block).toContain('不要擅自打包或重启')
  })

  it('picks up an edit on the next read without a restart', () => {
    const root = dataRoot()
    const file = seedMemoryDocument(root)
    writeFileSync(file, '## 必须遵守\n- 旧约定。\n', 'utf8')
    expect(memoryDocumentBlock()).toContain('旧约定')

    writeFileSync(file, '## 必须遵守\n- 新约定，多写几个字让文件大小也变。\n', 'utf8')
    expect(memoryDocumentBlock()).toContain('新约定')
    expect(memoryDocumentBlock()).not.toContain('旧约定')
  })

  it('truncates an over-long document instead of flooding every turn', () => {
    seedMemoryDocument(dataRoot())
    const file = memoryDocumentPath()!
    writeFileSync(file, `## 必须遵守\n- ${'长'.repeat(7_000)}\n`, 'utf8')
    const block = memoryDocumentBlock()
    expect(block.length).toBeLessThan(6_400)
    expect(block).toContain('已截断')
  })

  it('appends a note, refuses duplicates, and keeps the file editable', () => {
    const root = dataRoot()
    const file = seedMemoryDocument(root)

    const first = appendMemoryNote('以后不要擅自打包或重启。')
    expect(first.added).toBe(true)
    expect(readFileSync(file, 'utf8')).toContain('- 以后不要擅自打包或重启。')

    const again = appendMemoryNote('以后不要擅自打包或重启。')
    expect(again.added).toBe(false)
    expect(again.reason).toContain('记过')
    expect(readFileSync(file, 'utf8').match(/不要擅自打包或重启/gu)).toHaveLength(1)

    expect(memoryDocumentBlock()).toContain('不要擅自打包或重启')
  })

  it('rejects empty and over-long notes', () => {
    seedMemoryDocument(dataRoot())
    expect(appendMemoryNote('   ').added).toBe(false)
    expect(appendMemoryNote('长'.repeat(401))).toMatchObject({ added: false })
  })

  it('stays silent when no path is configured', () => {
    setMemoryDocumentPath(null)
    expect(readMemoryDocument()).toBe('')
    expect(memoryDocumentBlock()).toBe('')
    expect(appendMemoryNote('记一条').added).toBe(false)
  })
})
