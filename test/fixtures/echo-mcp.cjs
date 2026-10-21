#!/usr/bin/env node
/* Tiny stdio MCP server used by the ACP library-injection test. */
'use strict'

const readline = require('node:readline')

const tools = [{
  name: 'echo',
  description: 'Echo the given text back with an "echo:" prefix.',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  }
}]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  const id = message.id
  const method = message.method
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'echo', version: '1.0.0' }
      }
    })
    return
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } })
    return
  }
  if (method === 'tools/call') {
    const text = String(message.params?.arguments?.text ?? '')
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `echo: ${text}` }] }
    })
  }
}

const lines = readline.createInterface({ input: process.stdin })
lines.on('line', (line) => {
  try {
    handle(JSON.parse(line))
  } catch {
    // Ignore malformed frames; the test only sends valid ones.
  }
})
