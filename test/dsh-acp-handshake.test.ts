import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'
import { syncDshAcpModelPatch } from '../src/main/dsh-web-policy'

const live = process.env.DSH_HANDSHAKE === '1'

/** 这个测试只验证本地握手：不调用 DeepSeek 接口，也不需要真实 API Key。
 *  `DSH_HANDSHAKE=1 npx vitest run test/dsh-acp-handshake.test.ts`。 */
describe.skipIf(!live)('DSH ACP 图片握手', () => {
  it('profile 钉到 deepseek-flash 后，initialize 声明 image:true', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'whale-dsh-handshake-'))
    try {
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
      writeFileSync(path.join(profile, 'cordis.patch.yml'),
        '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n', 'utf8')
      syncDshAcpModelPatch(home, 'deepseek-official', 'deepseek-flash')

      const runtime = new DshAcpRuntime({
        bin: process.env.DSH_BIN ?? path.resolve('reference/dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js'),
        home,
        cwd: process.cwd(),
        systemPrompt: 'You are a test assistant.',
        env: { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'handshake-test-key' }
      })
      try {
        await runtime.start()
        expect(runtime.supportsImagePrompts).toBe(true)
      } finally {
        await runtime.close()
      }
    } finally {
      rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
    }
  }, 180_000)
})
