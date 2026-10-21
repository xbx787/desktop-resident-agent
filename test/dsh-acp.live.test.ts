import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DshAcpRuntime, toAcpMcpServer, type DshAcpMcpServer } from '../src/main/dsh-acp-runtime'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import { PetMcpBridge } from '../src/main/pet-mcp-server'
import type { ModelToolEvent } from '../src/main/deepseek'
import type { TaskUsage } from '../src/shared/contracts'

const live = process.env.DSH_LIVE === '1' && Boolean(process.env.DEEPSEEK_API_KEY)
const roots: string[] = []
const runtimes: DshAcpRuntime[] = []
const bridges: PetMcpBridge[] = []

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined)
  for (const bridge of bridges) await bridge.close().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function create(cwd: string, existingHome?: string) {
  const home = existingHome ?? mkdtempSync(path.join(tmpdir(), 'whale-dsh-acp-'))
  if (!existingHome) roots.push(home)
  const bridge = new PetMcpBridge()
  bridges.push(bridge)
  const libraries: { mcp: Record<string, unknown>; plugins: string[] } = { mcp: {}, plugins: [] }
  const runtime = new DshAcpRuntime({
    bin: path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    home,
    cwd,
    systemPrompt: 'You are a helpful assistant. Reply in the user language.',
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! },
    mcpServers: () => {
      const servers: DshAcpMcpServer[] = []
      const endpoint = bridge.endpoint
      if (endpoint) {
        servers.push({
          name: 'pet',
          command: process.execPath,
          args: [path.resolve('scripts/pet-mcp-bridge.cjs')],
          env: [
            { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
            { name: 'PET_BRIDGE_URL', value: endpoint.url },
            { name: 'PET_BRIDGE_TOKEN', value: endpoint.token }
          ]
        })
      }
      for (const [name, raw] of Object.entries(libraries.mcp)) {
        const server = toAcpMcpServer(name, raw)
        if (server) servers.push(server)
      }
      return servers
    }
  })
  runtimes.push(runtime)
  const client = new DshAcpAgentClient({ runtime, bridge, cwd, dshHome: home, libraries })
  return { client, bridge, runtime, home, libraries }
}

describe.skipIf(!live)('DSH ACP adapter', () => {
  it('runs a text turn through ModelClient', async () => {
    const { client } = create(process.cwd())
    const chunks: string[] = []
    const usages: TaskUsage[] = []
    const reply = await client.respond(
      [{ role: 'user', content: '只回复 OK' }],
      new AbortController().signal,
      (text) => chunks.push(text),
      undefined,
      undefined,
      (usage) => usages.push(usage)
    )
    expect(reply.text).toContain('OK')
    expect(reply.sdkSessionId).toBeTruthy()
    expect(chunks.length).toBeGreaterThan(0)
    expect(usages.at(-1)?.total).toBeGreaterThan(0)
  }, 180_000)

  it('maps tool call and tool result events', async () => {
    const { client } = create(process.cwd())
    const tools: ModelToolEvent[] = []
    const reply = await client.respond(
      [{ role: 'user', content: '先调用 working_directory 工具读取当前目录，然后用一句中文回复 OK' }],
      new AbortController().signal,
      undefined,
      undefined,
      (event) => tools.push(event)
    )
    const start = tools.find((event) => event.phase === 'start')
    const result = tools.find((event) => event.phase === 'result')
    expect(start?.toolName).toContain('working_directory')
    expect(result?.isError).toBe(false)
    expect(result?.output).toContain('DesktopPetProject')
    expect(reply.text).toContain('OK')
  }, 180_000)

  it('resumes a persisted session after a runtime restart', async () => {
    const first = create(process.cwd())
    const reply = await first.client.respond(
      [{ role: 'user', content: '请记住数字 42，只回复 OK' }],
      new AbortController().signal
    )
    expect(reply.text).toContain('OK')
    await first.runtime.close()
    await first.bridge.close()
    const second = create(process.cwd(), first.home)
    const resumed = await second.client.respond(
      [{ role: 'user', content: '我刚才让你记住的数字是多少？只回复数字' }],
      new AbortController().signal,
      undefined,
      reply.sdkSessionId
    )
    expect(resumed.text).toContain('42')
  }, 240_000)

  it('cancels a turn without killing the session', async () => {
    const { client } = create(process.cwd())
    await client.respond([{ role: 'user', content: '只回复 OK' }], new AbortController().signal)
    const controller = new AbortController()
    const pending = client.respond(
      [{ role: 'user', content: '请写一篇三千字的中文文章，标题为测试，慢慢写，不要省略。' }],
      controller.signal
    )
    setTimeout(() => controller.abort(), 1500)
    const reply = await pending
    expect(reply.interrupted).toBe(true)
    const again = await client.respond(
      [{ role: 'user', content: '只回复 OK' }],
      new AbortController().signal
    )
    expect(again.text.length).toBeGreaterThan(0)
  }, 240_000)

  it('injects an app library MCP server into the session', async () => {
    const { client, libraries } = create(process.cwd())
    libraries.mcp.echo = {
      type: 'stdio',
      command: process.execPath,
      args: [path.resolve('test/fixtures/echo-mcp.cjs')],
      env: {}
    }
    client.setLibraries(libraries.mcp, [])
    const tools: ModelToolEvent[] = []
    const reply = await client.respond(
      [{ role: 'user', content: '先调用 mcp__echo__echo 工具，参数 text 设为 hello，然后只回复 OK' }],
      new AbortController().signal,
      undefined,
      undefined,
      (event) => tools.push(event)
    )
    const start = tools.find((event) => event.phase === 'start')
    const result = tools.find((event) => event.phase === 'result')
    expect(start?.toolName).toContain('echo')
    expect(result?.isError).toBe(false)
    expect(result?.output).toContain('echo: hello')
    expect(reply.text.length).toBeGreaterThan(0)
  }, 240_000)

  it('enforces the read-only sandbox preset', async () => {
    const file = path.resolve('data/dsh-readonly-test.txt')
    rmSync(file, { force: true })
    const { client } = create(process.cwd())
    client.setApprovalMode('read-only')
    await client.respond(
      [{ role: 'user', content: `请直接在 ${file} 写入 hello；如果被权限阻止，只回复 BLOCKED。` }],
      new AbortController().signal
    )
    expect(existsSync(file)).toBe(false)
    rmSync(file, { force: true })
  }, 240_000)

  it('mounts the app MCP bridge through session/new', async () => {
    const { client, bridge } = create(process.cwd())
    bridge.setConversationBridge({
      list: () => [{ id: 'dev1', title: '开发1', running: true, archived: false }],
      send: async () => ({ id: 'dev1', title: '开发1' })
    })
    const tools: ModelToolEvent[] = []
    const reply = await client.respond(
      [{ role: 'user', content: '先调用 mcp__pet__conversations_list 工具，不要调用其它工具；工具返回后只回复 OK' }],
      new AbortController().signal,
      undefined,
      undefined,
      (event) => tools.push(event)
    )
    const start = tools.find((event) => event.phase === 'start')
    const result = tools.find((event) => event.phase === 'result')
    expect(start?.toolName).toContain('conversations_list')
    expect(result?.isError).toBe(false)
    expect(result?.output).toContain('开发1')
    expect(reply.text.length).toBeGreaterThan(0)
  }, 240_000)
})
