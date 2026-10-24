import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { PET_MCP_TOOLS, PetMcpBridge } from '../src/main/pet-mcp-server'
import { seedMemoryDocument, setMemoryDocumentPath } from '../src/main/memory-document'
import { writeDshProfile } from '../src/main/dsh-runtime'
import type { ConversationBridge } from '../src/main/conversation-tools'
import type { EvolveBridge } from '../src/main/evolve-tools'

const cleanups: Array<() => void | Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function conversationBridge(): ConversationBridge {
  return {
    list: () => [
      { id: 'a', title: '开发1', running: true, archived: false },
      { id: 'old', title: '旧对话', running: false, archived: true }
    ],
    send: async (target, message) => {
      if (target !== 'a') throw new Error('找不到目标对话。')
      return { id: 'a', title: `已送达：${message}` }
    }
  }
}

function evolveBridge(enabled: boolean): EvolveBridge {
  return {
    enabled: () => enabled,
    schedule: async (input) => ({ scheduled: true, input }),
    status: async () => ({ active: true, status: 'active' }),
    restart: async (version) => ({ scheduled: true, waiting: true, version })
  }
}

async function call(
  bridge: PetMcpBridge,
  tool: string,
  args: Record<string, unknown> = {},
  token?: string
): Promise<{ status: number; body: { content?: Array<{ text: string }>; isError?: boolean; error?: string } }> {
  const endpoint = bridge.endpoint
  if (!endpoint) throw new Error('bridge not started')
  const response = await fetch(`${endpoint.url}/call`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-pet-bridge-token': token ?? endpoint.token },
    body: JSON.stringify({ tool, args })
  })
  return { status: response.status, body: await response.json() as { content?: Array<{ text: string }>; isError?: boolean; error?: string } }
}

describe('PetMcpBridge', () => {
  it('lists and sends conversation messages with the loopback token', async () => {
    const bridge = new PetMcpBridge()
    bridge.setConversationBridge(conversationBridge())
    await bridge.start()
    cleanups.push(() => bridge.close())

    const listed = await call(bridge, 'conversations_list')
    expect(listed.status).toBe(200)
    const payload = JSON.parse(listed.body.content![0].text) as { conversations: Array<{ id: string }> }
    expect(payload.conversations.map((row) => row.id)).toEqual(['a'])

    const sent = await call(bridge, 'conversations_send_message', { target: 'a', message: '你好' })
    expect(sent.body.isError).toBeUndefined()
    expect(sent.body.content![0].text).toContain('已送达：你好')

    const missing = await call(bridge, 'conversations_send_message', { target: 'nope', message: '嗨' })
    expect(missing.body.isError).toBe(true)
  })

  it('rejects a wrong token and unknown tools', async () => {
    const bridge = new PetMcpBridge()
    await bridge.start()
    cleanups.push(() => bridge.close())

    const denied = await call(bridge, 'conversations_list', {}, 'wrong')
    expect(denied.status).toBe(401)

    const unknown = await call(bridge, 'not_a_tool')
    expect(unknown.status).toBe(400)
  })

  it('gates evolve tools on the approval tier', async () => {
    const blocked = new PetMcpBridge()
    blocked.setEvolveBridge(evolveBridge(false))
    await blocked.start()
    cleanups.push(() => blocked.close())
    const denied = await call(blocked, 'evolve_status')
    expect(denied.body.isError).toBe(true)
    expect(denied.body.content![0].text).toContain('自我进化')

    const allowed = new PetMcpBridge()
    allowed.setEvolveBridge(evolveBridge(true))
    await allowed.start()
    cleanups.push(() => allowed.close())
    const status = await call(allowed, 'evolve_status')
    expect(status.body.isError).toBeUndefined()
    expect(status.body.content![0].text).toContain('active')
  })

  it('validates DeepSeek tool arguments before any network call', async () => {
    const bridge = new PetMcpBridge()
    await bridge.start()
    cleanups.push(() => bridge.close())
    const noKey = await call(bridge, 'deepseek_search', { query: '测试' })
    expect(noKey.body.isError).toBe(true)
    expect(noKey.body.content![0].text).toContain('DeepSeek API Key')
  })

  it('writes a long-term memory note once and refuses the duplicate', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pet-memory-'))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }))
    const file = seedMemoryDocument(root)
    cleanups.push(() => setMemoryDocumentPath(null))

    const bridge = new PetMcpBridge()
    await bridge.start()
    cleanups.push(() => bridge.close())

    const saved = await call(bridge, 'memory_remember', { text: '以后不要擅自打包或重启。' })
    expect(saved.body.isError).toBeUndefined()
    expect(readFileSync(file, 'utf8')).toContain('- 以后不要擅自打包或重启。')

    const again = await call(bridge, 'memory_remember', { text: '以后不要擅自打包或重启。' })
    expect(again.body.isError).toBe(true)
    expect(readFileSync(file, 'utf8').match(/不要擅自打包或重启/gu)).toHaveLength(1)

    const empty = await call(bridge, 'memory_remember', { text: '  ' })
    expect(empty.body.isError).toBe(true)
  })
})

describe('pet-mcp-bridge stdio script', () => {
  it('speaks MCP initialize, tools/list, and forwards tools/call', async () => {
    const requests: Array<{ tool: string; args: Record<string, unknown> }> = []
    const server = createHttpServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { tool: string; args: Record<string, unknown> })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ content: [{ type: 'text', text: '{"ok":true}' }] }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no address')

    const child = spawn(process.execPath, [path.resolve('scripts/pet-mcp-bridge.cjs')], {
      env: {
        ...process.env,
        PET_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
        PET_BRIDGE_TOKEN: 'test-token'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    cleanups.push(() => { child.kill() })
    const lines = readline.createInterface({ input: child.stdout })
    const pending: Array<(value: Record<string, unknown>) => void> = []
    const messages: Record<string, unknown>[] = []
    lines.on('line', (line) => {
      const message = JSON.parse(line) as Record<string, unknown>
      messages.push(message)
      pending.shift()?.(message)
    })
    const next = (): Promise<Record<string, unknown>> => new Promise((resolve) => pending.push(resolve))
    const write = (message: unknown): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })
    const initialized = await next()
    expect((initialized.result as { serverInfo: { name: string } }).serverInfo.name).toBe('pet-bridge')

    write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const listed = await next()
    const tools = (listed.result as { tools: Array<{ name: string }> }).tools
    expect(tools.map((tool) => tool.name)).toEqual(PET_MCP_TOOLS.map((tool) => tool.name))

    write({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'conversations_list', arguments: {} }
    })
    const called = await next()
    expect((called.result as { content: Array<{ text: string }> }).content[0].text).toContain('ok')
    expect(requests).toEqual([{ tool: 'conversations_list', args: {} }])
  }, 20_000)
})

describe('writeDshProfile', () => {
  it('writes the pet MCP client row with the loopback endpoint', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-profile-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    writeDshProfile(home, {
      script: 'C:\\DesktopPetProject\\scripts\\pet-mcp-bridge.cjs',
      endpoint: () => ({ url: 'http://127.0.0.1:4321', token: "tok'en" })
    })
    const patch = readFileSync(path.join(home, 'profiles', 'sdk-minimal', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'")
    expect(patch).toContain("serverName: pet")
    expect(patch).toContain('C:/DesktopPetProject/scripts/pet-mcp-bridge.cjs')
    expect(patch).toContain("PET_BRIDGE_URL: 'http://127.0.0.1:4321'")
    expect(patch).toContain("PET_BRIDGE_TOKEN: 'tok''en'")
    expect(patch).toContain('failOnStartupError: true')
    const manifest = JSON.parse(readFileSync(path.join(home, 'profiles', 'sdk-minimal', 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-sdk-minimal'])
  })

  it('leaves an empty patch when no bridge is configured', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-profile-empty-'))
    cleanups.push(() => rmSync(home, { recursive: true, force: true }))
    writeDshProfile(home)
    const patch = readFileSync(path.join(home, 'profiles', 'sdk-minimal', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('[]')
    expect(patch).not.toContain('mcp-pet')
  })
})
