import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { rewriteEffort, startEffortProxy } from '../src/main/effort-proxy'

const messagesBody = (extra: Record<string, unknown> = {}) => JSON.stringify({
  model: 'deepseek-flash',
  stream: true,
  max_tokens: 32000,
  thinking: { type: 'adaptive', display: 'omitted' },
  output_config: { effort: 'max' },
  messages: [{ role: 'user', content: 'hi' }],
  ...extra
})

describe('rewriteEffort', () => {
  it('replaces the effort the CLI pinned, leaving everything else alone', () => {
    const rewritten = JSON.parse(rewriteEffort(messagesBody(), 'low'))
    expect(rewritten.output_config).toEqual({ effort: 'low' })
    expect(rewritten.thinking).toEqual({ type: 'enabled' })
    expect(rewritten.max_tokens).toBe(32000)
    expect(rewritten.messages).toEqual([{ role: 'user', content: 'hi' }])
  })

  it('turns "off" into disabled thinking, not a tiny budget', () => {
    const rewritten = JSON.parse(rewriteEffort(messagesBody(), 'off'))
    expect(rewritten.thinking).toEqual({ type: 'disabled' })
    expect(rewritten.output_config).toBeUndefined()
  })

  it('keeps sibling fields of output_config', () => {
    const rewritten = JSON.parse(rewriteEffort(messagesBody({ output_config: { effort: 'max', task_budget: 5 } }), 'high'))
    expect(rewritten.output_config).toEqual({ task_budget: 5, effort: 'high' })
  })

  it('passes through bodies it cannot act on', () => {
    const tokenCount = JSON.stringify({ model: 'deepseek-flash' })
    const broken = '{"model": "deepseek-flash",'
    expect(rewriteEffort(tokenCount, 'low')).toBe(tokenCount)
    expect(rewriteEffort(broken, 'low')).toBe(broken)
  })
})

describe('startEffortProxy', () => {
  let upstream: Server | undefined
  let proxy: Awaited<ReturnType<typeof startEffortProxy>> | undefined

  afterEach(async () => {
    await proxy?.close()
    proxy = undefined
    upstream?.close()
    upstream = undefined
  })

  it('rewrites what the upstream receives, and follows later slider moves', async () => {
    const seen: string[] = []
    upstream = createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(chunk as Buffer))
      request.on('end', () => {
        seen.push(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      })
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('no port')

    proxy = await startEffortProxy(`http://127.0.0.1:${address.port}`, 'low')
    const post = () => fetch(`${proxy!.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test' },
      body: messagesBody()
    }).then((response) => response.json())

    expect(await post()).toEqual({ ok: true })
    expect(JSON.parse(seen[0]).output_config.effort).toBe('low')

    proxy.setEffort('max')
    await post()
    expect(JSON.parse(seen[1]).output_config.effort).toBe('max')
    // The upstream never sees a compressed body or a stale content-length.
    expect(JSON.parse(seen[1]).messages).toHaveLength(1)
  })

  it('keeps the upstream base path: /anthropic must survive the hop', async () => {
    const seen: string[] = []
    upstream = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}')
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('no port')

    proxy = await startEffortProxy(`http://127.0.0.1:${address.port}/anthropic`, 'high')
    const response = await fetch(`${proxy.url}/v1/messages?beta=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: messagesBody()
    })
    expect(await response.json()).toEqual({ ok: true })
    // The v0.0.9 outage: a hand-rolled path dropped /anthropic and every request
    // 404ed upstream while every proxy-less probe stayed green.
    expect(seen).toEqual(['/anthropic/v1/messages?beta=true'])
  })

  it('forwards a root-path upstream without inventing a prefix', async () => {
    const seen: string[] = []
    upstream = createServer((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200)
      response.end()
    })
    await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('no port')

    proxy = await startEffortProxy(`http://127.0.0.1:${address.port}`, 'low')
    await fetch(`${proxy.url}/v1/messages`, { method: 'POST', body: messagesBody() })
    expect(seen).toEqual(['/v1/messages'])
  })
})
