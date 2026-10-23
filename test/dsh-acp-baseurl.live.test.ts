import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'
import { syncDshAcpModelPatch } from '../src/main/dsh-web-policy'

/** 不需要真实 API Key：本地假供应商只确认 DSH 把请求发到了
 *  DEEPSEEK_BASE_URL 指向的地址。用 401 让适配器快速失败，避免重试等待。 */
const live = process.env.DSH_LIVE === '1'
const home = mkdtempSync(path.join(tmpdir(), 'dsh-baseurl-'))
const seen: Array<{ path: string; body: string }> = []
let serverPort = 0

async function ensureServer(): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('no port')
    serverPort = address.port
  }
  return serverPort
}

function seedAcpProfile(home: string): void {
  const profile = path.join(home, 'profiles', 'acp')
  mkdirSync(profile, { recursive: true })
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-acp',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } }
  }, null, 2), 'utf8')
  writeFileSync(path.join(profile, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk) => chunks.push(chunk as Buffer))
  request.on('end', () => {
    seen.push({ path: request.url ?? '', body: Buffer.concat(chunks).toString('utf8') })
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'test only' } }))
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!live)('DSH 供应商地址实机验证', () => {
  it('把请求发到 DEEPSEEK_BASE_URL，而不是写死的官方地址', async () => {
    const port = await ensureServer()
    const runtime = new DshAcpRuntime({
      bin: path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
      home,
      cwd: process.cwd(),
      env: { DEEPSEEK_API_KEY: 'sk-test' }
    })
    // 与 setProvider 走同一条写入路径。
    runtime.setDeepSeekEnvironment({ apiKey: 'sk-test', baseUrl: `http://127.0.0.1:${port}` })
    await runtime.start()
    const session = await runtime.newSession(process.cwd())
    await runtime.prompt(session.sessionId, [{ type: 'text', text: '只回复 OK' }], 20_000).catch(() => undefined)
    await runtime.close()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((item) => item.path.startsWith('/v1/messages'))).toBe(true)
    expect(seen.some((item) => item.body.includes('deepseek'))).toBe(true)
  }, 60_000)

  it('注入自定义模型目录后，ACP 接受非 DeepSeek 模型并在请求里使用它', async () => {
    const customHome = mkdtempSync(path.join(tmpdir(), 'dsh-catalog-'))
    const seenBefore = seen.length
    try {
      const port = await ensureServer()
      const baseUrl = `http://127.0.0.1:${port}`
      seedAcpProfile(customHome)
      syncDshAcpModelPatch(customHome, 'deepseek-official', 'Kimi-K3', baseUrl)
      const runtime = new DshAcpRuntime({
        bin: path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
        home: customHome,
        cwd: process.cwd(),
        env: { DEEPSEEK_API_KEY: 'sk-test' }
      })
      runtime.setDeepSeekEnvironment({ apiKey: 'sk-test', baseUrl })
      await runtime.start()
      const session = await runtime.newSession(process.cwd())
      const result = await runtime.request('session/set_config_option', {
        sessionId: session.sessionId,
        configId: 'model',
        value: JSON.stringify(['deepseek-official', 'Kimi-K3'])
      }, 15_000)
      expect(JSON.stringify(result)).toContain('Kimi-K3')
      await runtime.prompt(session.sessionId, [{ type: 'text', text: '只回复 OK' }], 20_000).catch(() => undefined)
      await runtime.close()
      expect(seen.slice(seenBefore).some((item) => item.body.includes('Kimi-K3'))).toBe(true)
    } finally {
      rmSync(customHome, { recursive: true, force: true })
    }
  }, 60_000)
})
