import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadWindowsMcpConfig } from '../src/main/mcp-config'

describe('Windows MCP config reuse', () => {
  it('loads only the existing Windows MCP server from Claude config', async () => {
    const root = path.join(process.cwd(), '.cache', 'tests', `mcp-${randomUUID()}`)
    const file = path.join(root, 'claude.json')
    try {
      await fs.mkdir(root, { recursive: true })
      await fs.writeFile(file, JSON.stringify({ mcpServers: {
        'windows-mcp': { type: 'stdio', command: process.execPath, args: ['--version'], env: { TEST_FLAG: '1' } },
        'other-server': { type: 'stdio', command: process.execPath }
      } }), 'utf8')
      expect(loadWindowsMcpConfig(file)).toEqual({
        'windows-mcp': { type: 'stdio', command: process.execPath, args: ['--version'], env: { TEST_FLAG: '1' } }
      })
      await fs.writeFile(file, '{broken json', 'utf8')
      expect(loadWindowsMcpConfig(file)).toEqual({})
    } finally {
      const relative = path.relative(process.cwd(), root)
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.')
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})
