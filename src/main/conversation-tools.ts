/** 对话之间的消息通道。
 *
 *  以进程内 MCP server 的形式交给模型：它可以列出本应用里的其他对话，并把
 *  一条消息转给其中一个。目标对话收到的是普通的用户消息（带来源标记），
 *  会照常触发它的模型回复——所以工具描述要求只在用户明确要求转达时使用。
 */
import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface ConversationTarget {
  id: string
  title: string
  running: boolean
  archived: boolean
}

export interface ConversationBridge {
  list: () => ConversationTarget[]
  send: (target: string, text: string) => Promise<{ id: string; title: string }>
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

export function createConversationToolsServer(bridge: ConversationBridge) {
  const listTool = {
    name: 'list',
    description: '列出本应用里的其他对话及其运行状态。仅在需要给另一个对话转达消息时使用；返回 id、标题、是否正在运行。',
    inputSchema: {},
    handler: async () => ok({
      conversations: bridge.list()
        .filter((target) => !target.archived)
        .map((target) => ({ id: target.id, title: target.title, running: target.running }))
    })
  }
  const sendTool = {
    name: 'send_message',
    description: '向本应用里的另一个对话发送一条消息。仅在用户明确要求转达时使用；对方会像收到用户消息一样处理，可能触发它的模型回复并产生费用。target 用清单里的 id 或唯一标题。',
    inputSchema: {
      target: z.string().describe('目标对话的 id 或唯一标题'),
      message: z.string().describe('要转达的正文，最多 8000 字')
    },
    handler: async (args: { target?: unknown; message?: unknown }) => {
      const target = typeof args.target === 'string' ? args.target.trim() : ''
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      if (!target) return fail('缺少目标对话。')
      if (!message) return fail('消息不能为空。')
      if (message.length > 8_000) return fail('消息超过 8000 字，请缩短。')
      try {
        const delivered = await bridge.send(target, message)
        return ok({ delivered: true, conversationId: delivered.id, title: delivered.title })
      } catch (error) {
        return fail(error instanceof Error ? error.message : '消息没有送达。')
      }
    }
  }
  return createSdkMcpServer({
    name: 'conversations',
    version: '1.0.0',
    instructions: '对话间消息：list 查看其他对话，send_message 转达一条消息。只在用户明确要求时使用，不要擅自给其他对话发消息。',
    tools: [listTool, sendTool] as unknown as Array<SdkMcpToolDefinition>
  })
}
