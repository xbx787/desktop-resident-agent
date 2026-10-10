import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { findClaudeExecutable } from '../src/main/claude-code'
import { startEffortProxy } from '../src/main/effort-proxy'

const enabled = process.env.DESKTOP_PET_LIVE_SDK_TEST === '1'
const executable = findClaudeExecutable(process.env)

/** End to end with the real CLI and no network: the CLI must reach the in-app
 *  proxy, and the upstream (what DeepSeek would see) must carry the depth we
 *  picked — the CLI itself pins non-Claude model names to "max", which is the
 *  whole reason this proxy exists. Gated like the other live checks:
 *    DESKTOP_PET_LIVE_SDK_TEST=1 npx vitest run test/effort-proxy.live.test.ts
 */
describe.skipIf(!enabled || !executable)('effort proxy with the installed CLI', () => {
  it('puts the chosen effort on the wire for deepseek-flash[1m]', { timeout: 120_000 }, async () => {
    const seen: string[] = []
    const upstream: Server = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk as Buffer))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        seen.push(body)
        if (request.url?.includes('count_tokens')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ input_tokens: 1 }))
          return
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end([
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_live","type":"message","role":"assistant","model":"probe","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
          'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
          'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
          'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
          'event: message_stop\ndata: {"type":"message_stop"}\n\n'
        ].join(''))
      })
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('no upstream port')

    const proxy = await startEffortProxy(`http://127.0.0.1:${address.port}`, 'high')
    const child = spawn(executable!, ['-p', '打个招呼', '--output-format', 'json', '--max-turns', '1'], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: proxy.url,
        ANTHROPIC_AUTH_TOKEN: 'proxy-test-token',
        ANTHROPIC_MODEL: 'deepseek-flash[1m]',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash[1m]',
        CLAUDE_CONFIG_DIR: mkdtempSync(path.join(tmpdir(), 'effort-probe-')),
        CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'
      },
      timeout: 110_000
    })
    await new Promise((resolve) => child.on('close', resolve))
    await proxy.close()
    await new Promise((resolve) => upstream.close(resolve))

    const conversation = seen.find((body) => body.includes('"messages"'))
    expect(conversation, 'the CLI never reached the proxy').toBeTruthy()
    const parsed = JSON.parse(conversation!) as { output_config?: unknown; thinking?: unknown }
    expect(parsed.output_config).toEqual({ effort: 'high' })
    expect(parsed.thinking).toEqual({ type: 'enabled' })
  })
})
