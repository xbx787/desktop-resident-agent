import { deflateSync } from 'node:zlib'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'
import { DshAcpAgentClient } from '../src/main/dsh-acp-agent'
import { PetMcpBridge } from '../src/main/pet-mcp-server'
import { syncDshAcpModelPatch } from '../src/main/dsh-web-policy'
import type { ModelToolEvent } from '../src/main/deepseek'

const live = process.env.DSH_LIVE === '1' && Boolean(process.env.DEEPSEEK_API_KEY)
const cleanup: Array<() => Promise<void>> = []

afterAll(async () => {
  for (const run of cleanup.splice(0)) await run()
})

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, tail])
}

/** 生成一张纯色 PNG；不依赖图像库，避免测试环境额外安装。 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1)
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 4
      raw[at] = rgb[0]
      raw[at + 1] = rgb[1]
      raw[at + 2] = rgb[2]
      raw[at + 3] = 255
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

async function createClient(options: { root?: string; model?: string } = {}) {
  const root = options.root ?? mkdtempSync(path.join(tmpdir(), 'whale-dsh-image-'))
  const home = path.join(root, 'home')
  const profile = path.join(home, 'profiles', 'acp')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-acp',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } }
  }, null, 2)}\n`, 'utf8')
  writeFileSync(path.join(profile, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  writeFileSync(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')
  const model = options.model ?? 'deepseek-flash'
  syncDshAcpModelPatch(home, 'deepseek-official', model)

  const bridge = new PetMcpBridge(process.env.DEEPSEEK_API_KEY)
  const cwd = path.join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const runtime = new DshAcpRuntime({
    bin: process.env.DSH_BIN ?? path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
    home,
    cwd,
    systemPrompt: 'You are a helpful assistant. Reply in the user language.',
    env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY! }
  })
  const client = new DshAcpAgentClient({
    runtime,
    bridge,
    cwd,
    provider: 'deepseek-official',
    model,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    dshHome: home
  })
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await runtime.close().catch(() => undefined)
    await bridge.close().catch(() => undefined)
  }
  cleanup.push(async () => {
    await close()
    if (!options.root) {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
      } catch {
        // 临时目录留给系统清理；DSH 子进程在 Windows 上可能还短暂握着句柄。
      }
    }
  })
  return { client, cwd, root, home, close }
}

describe.skipIf(!live)('DSH ACP 图片输入', () => {
  it('read_image 能把图片交给模型，之后含图历史仍可继续纯文本对话', async () => {
    const { client, cwd } = await createClient()
    // 复现真实应用路径：设置里给的是 Claude 侧别名，运行中再 setProvider。
    client.setProvider({
      baseUrl: 'https://api.deepseek.com',
      apiKey: process.env.DEEPSEEK_API_KEY!,
      model: 'deepseek-flash[1m]'
    })
    const imagePath = path.join(cwd, 'red.png')
    writeFileSync(imagePath, solidPng(32, 32, [255, 0, 0]))

    const tools: ModelToolEvent[] = []
    const first = await client.respond(
      [{ role: 'user', content: `请调用 read_image 工具读取 ${imagePath}，然后只回答图片的主色调英文（red/green/blue）。` }],
      new AbortController().signal,
      undefined,
      undefined,
      (event) => tools.push(event)
    )
    const result = tools.find((event) => event.phase === 'result')
    expect(result?.isError).toBe(false)
    expect(first.text).toMatch(/red/iu)
    expect(client.imageInputSupport()).toBe(true)

    const second = await client.respond(
      [{ role: 'user', content: '图片已经在历史里了。只回复 OK。' }],
      new AbortController().signal,
      undefined,
      first.sdkSessionId
    )
    expect(second.text).toMatch(/OK/u)
    expect(second.text).not.toMatch(/UNSUPPORTED_CONTENT|image input requires/u)
  }, 300_000)

  it('宿主直接附带的图片能进入 prompt 并被模型识别', async () => {
    const { client } = await createClient()
    const blue = solidPng(32, 32, [0, 0, 255])
    const reply = await client.respond(
      [{ role: 'user', content: '只回答这张图片的主色调英文（red/green/blue）。' }],
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ name: 'blue.png', mimeType: 'image/png', data: blue.toString('base64') }]
    )
    expect(reply.text).toMatch(/blue/iu)
    expect(reply.text).not.toMatch(/UNSUPPORTED_CONTENT/u)
  }, 300_000)

  it('同一会话切到纯文本模型后，带图历史连续 3 轮不失败', async () => {
    const first = await createClient()
    const blue = solidPng(32, 32, [0, 0, 255])
    const seeded = await first.client.respond(
      [{ role: 'user', content: '只回答这张图片的主色调英文（red/green/blue）。' }],
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [{ name: 'blue.png', mimeType: 'image/png', data: blue.toString('base64') }]
    )
    expect(seeded.text).toMatch(/blue/iu)
    await first.close()

    // 同一个会话历史（含图片）换到纯文本模型：投影应把图片换成文本占位，
    // 而不是把 image 块原样交给适配器抛 UNSUPPORTED_CONTENT。
    const second = await createClient({ root: first.root, model: 'deepseek-v4-pro' })
    for (let turn = 1; turn <= 3; turn += 1) {
      const reply = await second.client.respond(
        [{ role: 'user', content: `这是第 ${turn} 条纯文本。只回复 OK。` }],
        new AbortController().signal,
        undefined,
        seeded.sdkSessionId
      )
      expect(reply.text).toMatch(/OK/u)
      expect(reply.text).not.toMatch(/UNSUPPORTED_CONTENT|image input requires/u)
    }
  }, 600_000)
})
