import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DshRuntime } from '../src/main/dsh-runtime'
import { DshAgentClient } from '../src/main/dsh-agent'
import { PetMcpBridge } from '../src/main/pet-mcp-server'
import type { ModelToolEvent } from '../src/main/deepseek'

const live = process.env.DSH_LIVE === '1' && Boolean(process.env.DEEPSEEK_API_KEY)
const roots: string[] = []
const runtimes: DshRuntime[] = []
const bridges: PetMcpBridge[] = []

afterAll(async () => {
  for (const runtime of runtimes) await runtime.close().catch(() => undefined)
  for (const bridge of bridges) await bridge.close().catch(() => undefined)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(!live)('DSH live adapter', () => {
  it('runs a text turn through ModelClient', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-'))
    roots.push(home)
    const bin = path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const runtime = new DshRuntime({
      bin,
      home,
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! }
    })
    runtimes.push(runtime)
    const bridge = new PetMcpBridge()
    bridges.push(bridge)
    const client = new DshAgentClient({ runtime, bridge, cwd: process.cwd() })
    const chunks: string[] = []
    const reply = await client.respond(
      [{ role: 'user', content: '只回复 OK' }],
      new AbortController().signal,
      (text) => chunks.push(text)
    )
    expect(reply.text).toContain('OK')
    expect(reply.sdkSessionId).toBeTruthy()
    expect(chunks.length).toBeGreaterThan(0)
  }, 180_000)

  it('bridges app MCP tools through the local HTTP bridge', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-mcp-'))
    roots.push(home)
    const bin = path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const bridge = new PetMcpBridge()
    bridges.push(bridge)
    bridge.setConversationBridge({
      list: () => [{ id: 'dev1', title: '开发1', running: true, archived: false }],
      send: async () => ({ id: 'dev1', title: '开发1' })
    })
    const runtime = new DshRuntime({
      bin,
      home,
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! },
      mcpBridge: { script: path.resolve('scripts/pet-mcp-bridge.cjs'), endpoint: () => bridge.endpoint }
    })
    runtimes.push(runtime)
    const client = new DshAgentClient({ runtime, bridge, cwd: process.cwd() })
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
    expect(reply.text).toContain('OK')
  }, 240_000)

  it('maps tool call and tool result events', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-tools-'))
    roots.push(home)
    const bin = path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const runtime = new DshRuntime({
      bin,
      home,
      cwd: process.cwd(),
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! }
    })
    runtimes.push(runtime)
    const bridge = new PetMcpBridge()
    bridges.push(bridge)
    const client = new DshAgentClient({ runtime, bridge, cwd: process.cwd() })
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
    expect(start?.toolName).toBe('working_directory')
    expect(result?.isError).toBe(false)
    expect(result?.output).toContain('DesktopPetProject')
    expect(reply.text).toContain('OK')
  }, 180_000)
})
