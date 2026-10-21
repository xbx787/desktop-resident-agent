#!/usr/bin/env node
/* stdio MCP server that forwards the app's in-process tools to the loopback
 * HTTP bridge owned by the Electron main process.
 *
 * DSH launches this as `mcp__pet__*`; Claude Code keeps using its in-process
 * servers. Keep TOOLS in sync with src/main/pet-mcp-server.ts — the test
 * `test/pet-mcp-bridge.test.ts` compares both lists.
 */
'use strict'

const http = require('node:http')
const https = require('node:https')

const TOOLS = [
  {
    name: 'conversations_list',
    description: '列出本应用里的其他对话及其运行状态。仅在需要给另一个对话转达消息时使用；返回 id、标题、是否正在运行。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'conversations_send_message',
    description: '向本应用里的另一个对话发送一条消息。仅在用户明确要求转达时使用；对方会像收到用户消息一样处理，可能触发它的模型回复并产生费用。target 用清单里的 id 或唯一标题。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '目标对话的 id 或唯一标题' },
        message: { type: 'string', description: '要转达的正文，最多 8000 字' }
      },
      required: ['target', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'evolve_schedule',
    description: '安排重启后继续执行的一步：prompt 是重启后发给本对话的指令，command 是重启后在本机执行的命令，goal 是要跨重启保留的目标条件。可以同时给多项。只在用户要求自我更新、并已切到「自我进化」模式时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '重启后要继续的目标条件；会重新发送 /goal' },
        prompt: { type: 'string', description: '重启后发给本对话的指令' },
        command: { type: 'string', description: '重启后在应用工作目录执行的 shell 命令' },
        note: { type: 'string', description: '写进任务备注的说明' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'evolve_status',
    description: '读取当前自我进化任务：状态、目标、待执行步骤和已执行结果。只在「自我进化」模式下可用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'evolve_restart',
    description: '保存当前自我进化任务并重启应用。等当前回合结束后执行；可以传 version 切到已经打包好的 release 版本（例如 0.0.88）。自我更新前先运行 npm run pack:release 生成新版本，再传版本号。只在用户明确要求自我更新、并已切到「自我进化」模式时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string', description: '要启动的发布版本号，例如 0.0.88；不传则重启当前版本' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'request_approval',
    description: '在角色旁弹出一个小批准卡（绿勾批准、红叉拒绝），用于打包、重启、自我更新这类必须先征得用户同意的操作。返回 approved:true/false；超时返回 approved:null。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话说明要批准什么' },
        detail: { type: 'string', description: '补充说明，最多 300 字' }
      },
      required: ['title'],
      additionalProperties: false
    }
  },
  {
    name: 'deepseek_search',
    description: '用 DeepSeek 自研搜索引擎搜索网页。返回标题、链接与摘要；需要全文时再用 deepseek_fetch 抓取对应链接。支持 site:、lang:、after: 等搜索操作符。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        count: { type: 'number', description: '返回条数，1-10，默认 6' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },
  {
    name: 'deepseek_fetch',
    description: '抓取一个网页并返回 Markdown 正文。由 DeepSeek 服务端抓取，不受本机网络与客户端域名校验影响。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 HTTP/HTTPS 网址' } },
      required: ['url'],
      additionalProperties: false
    }
  }
  // 联网搜索关闭时（PET_MCP_WEB=0），搜索/抓取工具直接从列表里消失，
  // 模型不会先尝试一次再被拒绝。
].filter((tool) => process.env.PET_MCP_WEB !== '0' || !tool.name.startsWith('deepseek_'))

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function post(url, token, body) {
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('桥接地址无效。'))
      return
    }
    const payload = JSON.stringify(body)
    const transport = parsed.protocol === 'https:' ? https : http
    const request = transport.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: '/call',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'x-pet-bridge-token': token
      },
      timeout: 310000
    }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        let value
        try {
          value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          reject(new Error(`桥接返回了无法解析的内容（HTTP ${response.statusCode}）。`))
          return
        }
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(value && value.error ? String(value.error) : `桥接请求失败（HTTP ${response.statusCode}）。`))
          return
        }
        resolve(value)
      })
    })
    request.on('timeout', () => request.destroy(new Error('桥接请求超时。')))
    request.on('error', reject)
    request.end(payload)
  })
}

async function callTool(name, args) {
  const endpoint = process.env.PET_BRIDGE_URL
  const token = process.env.PET_BRIDGE_TOKEN
  if (!endpoint || !token) {
    return { content: [{ type: 'text', text: '本地工具桥接没有配置。' }], isError: true }
  }
  try {
    const result = await post(endpoint, token, { tool: name, args: args || {} })
    if (!result || !Array.isArray(result.content)) {
      return { content: [{ type: 'text', text: '本地工具桥接返回了空结果。' }], isError: true }
    }
    return result
  } catch (error) {
    return {
      content: [{ type: 'text', text: `本地工具桥接不可用：${error && error.message ? error.message : String(error)}` }],
      isError: true
    }
  }
}

async function handle(message) {
  const id = message.id
  const method = typeof message.method === 'string' ? message.method : ''
  const params = message.params && typeof message.params === 'object' ? message.params : {}
  if (method === 'initialize') {
    reply(id, {
      protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'pet-bridge', version: '1.0.0' }
    })
    return
  }
  if (method === 'notifications/initialized') return
  if (method === 'ping') {
    reply(id, {})
    return
  }
  if (method === 'tools/list') {
    reply(id, { tools: TOOLS })
    return
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : ''
    if (!TOOLS.some((tool) => tool.name === name)) {
      replyError(id, -32602, `未知工具：${name}`)
      return
    }
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    reply(id, await callTool(name, args))
    return
  }
  if (method === 'resources/list') {
    reply(id, { resources: [] })
    return
  }
  if (method === 'prompts/list') {
    reply(id, { prompts: [] })
    return
  }
  if (id !== undefined) replyError(id, -32601, `未实现的方法：${method}`)
}

function start() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line) {
        let message
        try {
          message = JSON.parse(line)
        } catch {
          message = undefined
        }
        if (message && typeof message === 'object') {
          handle(message).catch((error) => {
            if (message.id !== undefined) {
              replyError(message.id, -32603, error && error.message ? error.message : String(error))
            }
          })
        }
      }
      index = buffer.indexOf('\n')
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

if (require.main === module) start()

module.exports = { TOOLS, callTool }
