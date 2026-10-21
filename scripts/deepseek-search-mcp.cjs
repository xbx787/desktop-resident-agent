/** Minimal stdio MCP server for DeepSeek search/fetch.
 *
 *  The app's own DeepSeek tools live inside the Electron process, so a headless
 *  `claude -p` run cannot see them. This standalone server lets the scheduled
 *  18:00 job search without depending on the interactive session.
 *
 *  Protocol: newline-delimited JSON-RPC over stdin/stdout; logs go to stderr.
 *  The API key is read from DEEPSEEK_API_KEY and never printed. */

const BASE_URL = 'https://api.deepseek.com'

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

async function request(path, body) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY is not set')
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(`DeepSeek ${path} HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
  }
  return response.json()
}

const tools = [
  {
    name: 'search',
    description: 'Search the web with DeepSeek. Returns titles, URLs and snippets.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'number', description: 'Result count, 1-10, default 6' }
      },
      required: ['query']
    }
  },
  {
    name: 'fetch',
    description: 'Fetch one HTTP/HTTPS page as Markdown through DeepSeek.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Page URL' } },
      required: ['url']
    }
  }
]

async function callTool(name, args) {
  if (name === 'search') {
    const query = typeof args?.query === 'string' ? args.query.trim() : ''
    if (!query) return textResult('query is required', true)
    try {
      const data = await request('/v1/tools/search', {
        query,
        count: Math.min(10, Math.max(1, Math.round(Number(args?.count) || 6))),
        need_content: false
      })
      return textResult(JSON.stringify(data.results ?? [], null, 2))
    } catch (error) {
      return textResult(error instanceof Error ? error.message : 'search failed', true)
    }
  }
  if (name === 'fetch') {
    const url = typeof args?.url === 'string' ? args.url.trim() : ''
    if (!/^https?:\/\//i.test(url)) return textResult('url must be http(s)', true)
    try {
      const data = await request('/v1/tools/fetch', { url })
      return textResult(JSON.stringify(data, null, 2))
    } catch (error) {
      return textResult(error instanceof Error ? error.message : 'fetch failed', true)
    }
  }
  return textResult(`unknown tool: ${name}`, true)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const { id, method, params } = message ?? {}
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'deepseek', version: '1.0.0' }
        }
      })
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools } })
    } else if (method === 'tools/call') {
      Promise.resolve(callTool(params?.name, params?.arguments)).then((result) => {
        send({ jsonrpc: '2.0', id, result })
      }).catch((error) => {
        send({ jsonrpc: '2.0', id, result: textResult(error instanceof Error ? error.message : 'tool failed', true) })
      })
    } else if (method === 'notifications/initialized' || method === 'initialized') {
      // Notification: no reply.
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    }
  }
})
