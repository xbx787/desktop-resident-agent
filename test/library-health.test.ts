import { createServer } from 'node:http'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeLibrary } from '../src/main/library-health'
import type { LibraryItem } from '../src/shared/libraries'

const roots: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mcp(overrides: Partial<LibraryItem> = {}): LibraryItem {
  return {
    id: 'demo', kind: 'mcp', name: 'demo', description: '', source: 'test',
    launch: { type: 'mcp', command: 'definitely-not-a-real-command-xyz' },
    ...overrides
  }
}

describe('库条目健康检查', () => {
  it('检查 stdio 命令是否存在', async () => {
    await expect(probeLibrary(mcp())).resolves.toMatchObject({ ok: false })
    await expect(probeLibrary(mcp({ launch: { type: 'mcp', command: process.execPath } })))
      .resolves.toMatchObject({ ok: true })
  })

  it('检查 HTTP MCP 是否有响应', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200)
      response.end('ok')
    })
    servers.push(server)
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('no port')
        resolve(address.port)
      })
    })
    await expect(probeLibrary(mcp({ launch: { type: 'mcp', url: `http://127.0.0.1:${port}/mcp` } })))
      .resolves.toMatchObject({ ok: true })
    await expect(probeLibrary(mcp({ launch: { type: 'mcp', url: 'http://127.0.0.1:1/mcp' } })))
      .resolves.toMatchObject({ ok: false })
  })

  it('技能/插件检查安装目录，停用条目直接视为安全跳过', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'library-health-'))
    roots.push(root)
    mkdirSync(path.join(root, 'skill'), { recursive: true })
    await expect(probeLibrary({ id: 's', kind: 'skill', name: 's', description: '', source: 'test', path: path.join(root, 'skill') }))
      .resolves.toMatchObject({ ok: true })
    await expect(probeLibrary({ id: 's', kind: 'skill', name: 's', description: '', source: 'test', path: path.join(root, 'missing') }))
      .resolves.toMatchObject({ ok: false })
    await expect(probeLibrary({ ...mcp(), disabled: true })).resolves.toMatchObject({ ok: true })
  })
})
