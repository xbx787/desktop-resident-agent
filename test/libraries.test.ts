import { describe, expect, it } from 'vitest'
import { isLibraryItem, libraryMentionToken, parseLibraryMentions } from '../src/shared/libraries'

describe('library mentions', () => {
  it('inserts a kind:id token that parses back', () => {
    const token = libraryMentionToken({ kind: 'mcp', id: 'io.github.demo/server' })
    expect(token).toBe('@mcp:io.github.demo/server')
    expect(parseLibraryMentions(`用 ${token} 看一下`)).toEqual([{ kind: 'mcp', id: 'io.github.demo/server' }])
  })

  it('deduplicates and keeps different kinds apart', () => {
    expect(parseLibraryMentions('@skill:anthropics/pdf @skill:anthropics/pdf @plugin:demo')).toEqual([
      { kind: 'skill', id: 'anthropics/pdf' },
      { kind: 'plugin', id: 'demo' }
    ])
  })

  it('leaves email addresses and plain @ words alone', () => {
    expect(parseLibraryMentions('mail me at a@mcp:example.com or just @ here')).toEqual([])
  })
})

describe('market entry validation', () => {
  const base = { id: 'demo', kind: 'mcp', name: 'Demo', description: 'x', source: 'test' }

  it('accepts a stdio launch and rejects path-like repos', () => {
    expect(isLibraryItem({ ...base, launch: { type: 'mcp', command: 'npx', args: ['-y', 'pkg'], env: ['KEY'] } })).toBe(true)
    expect(isLibraryItem({ ...base, repo: '../escape' })).toBe(false)
    expect(isLibraryItem({ ...base, subdir: '../escape' })).toBe(false)
  })

  it('rejects unknown kinds and malformed launches', () => {
    expect(isLibraryItem({ ...base, kind: 'theme' })).toBe(false)
    expect(isLibraryItem({ ...base, launch: { type: 'mcp', args: [1] } })).toBe(false)
  })
})
