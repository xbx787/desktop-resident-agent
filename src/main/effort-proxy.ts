import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https'
import zlib from 'node:zlib'
import type { EffortLevel } from '../shared/contracts'

/**
 * The Claude Code CLI pins `output_config.effort` to "max" for non-Claude model
 * names like ours (verified on the wire: --effort and effortLevel are silently
 * downgraded), and DeepSeek ignores `thinking.budget_tokens` entirely. So the
 * only honest place to set the depth is the request body itself: the CLI is
 * pointed at this loopback proxy, which rewrites exactly the two fields
 * DeepSeek documents — `output_config.effort` (low/high/max) and
 * `thinking.type` (enabled/disabled) — and forwards everything else untouched.
 */

/** Rewrite one /v1/messages body for the chosen depth. Anything that is not a
 *  JSON messages request (count_tokens, malformed bodies) passes through. */
export function rewriteEffort(body: string, level: EffortLevel): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return body
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray((parsed as { messages?: unknown }).messages)) return body
  const request = parsed as Record<string, unknown>
  if (level === 'off') {
    request.thinking = { type: 'disabled' }
    delete request.output_config
  } else {
    request.thinking = { type: 'enabled' }
    const existing = request.output_config && typeof request.output_config === 'object' ? request.output_config as Record<string, unknown> : {}
    request.output_config = { ...existing, effort: level }
  }
  return JSON.stringify(request)
}

export interface EffortProxy {
  /** Loopback base URL to hand to the CLI. */
  url: string
  setEffort(level: EffortLevel): void
  close(): Promise<void>
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host'])
const MAX_BODY = 256 * 1024 * 1024
const agent = new HttpsAgent({ keepAlive: true, maxSockets: 32 })

/** Start a 127.0.0.1-only rewrite proxy in front of `upstream`. */
export async function startEffortProxy(upstream: string, initial: EffortLevel): Promise<EffortProxy> {
  const target = new URL(upstream)
  let level = initial
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const chunk of request) {
        size += chunk.length
        if (size > MAX_BODY) {
          response.writeHead(413, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: '请求体过大。' } }))
          return
        }
        chunks.push(chunk as Buffer)
      }
    } catch {
      response.destroy()
      return
    }
    let body = Buffer.concat(chunks)
    if (request.headers['content-encoding']?.includes('gzip')) {
      try {
        body = zlib.gunzipSync(body)
      } catch {
        // Leave the bytes as they are; the request will fail upstream instead of here.
      }
    }
    const rewritten = Buffer.from(rewriteEffort(body.toString('utf8'), level), 'utf8')

    const headers: Record<string, string | string[]> = {}
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined || HOP_BY_HOP.has(name.toLowerCase()) || name.toLowerCase() === 'content-encoding') continue
      headers[name] = value
    }
    headers['content-length'] = String(rewritten.length)

    const secure = target.protocol === 'https:'
    // 上游基线路径必须拼回去（如 https://api.deepseek.com/anthropic 的 /anthropic），
    // 否则请求直接打到上游根路径，全部 404——曾经的事故就是这里丢了 /anthropic。
    // 用标准相对解析拼接：base 补尾斜杠后按相对路径解析。绝不能直接
    // new URL(request.url, target)：以 / 开头的绝对路径会整段替换 base 的 path。
    const basePath = target.pathname === '/' ? '' : target.pathname.replace(/\/$/u, '')
    let upstreamPath: string
    try {
      const resolved = new URL((request.url ?? '/').replace(/^\/+/u, ''), new URL(`${basePath}/`, target.origin))
      upstreamPath = `${resolved.pathname}${resolved.search}`
    } catch {
      upstreamPath = `${basePath}${request.url ?? '/'}`
    }
    const upstreamRequest = (secure ? httpsRequest : httpRequest)({
      hostname: target.hostname,
      port: target.port || (secure ? 443 : 80),
      path: upstreamPath,
      method: request.method,
      headers,
      ...(secure ? { agent } : {})
    }, (upstreamResponse) => {
      const outHeaders: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
        outHeaders[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, outHeaders)
      response.socket?.setNoDelay(true)
      upstreamResponse.pipe(response)
      upstreamResponse.on('error', () => response.destroy())
    })

    upstreamRequest.on('error', (error: Error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `连接上游失败：${error.message}` } }))
      } else {
        response.destroy()
      }
    })
    // The client went away first: cancel the upstream request too.
    response.on('close', () => {
      if (!response.writableEnded) upstreamRequest.destroy()
    })

    if (rewritten.length) upstreamRequest.write(rewritten)
    upstreamRequest.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('无法启动请求改写代理。')
  return {
    url: `http://127.0.0.1:${address.port}`,
    setEffort(next) { level = next },
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }
}
