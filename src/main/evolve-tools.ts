/** Self-evolution tools exposed to the model in the selfEvolve approval tier.
 *
 *  The tools only persist intent. Restarting is delegated to the main process
 *  bridge, which waits for the running turn to become idle and then relaunches
 *  (optionally into a freshly packaged version). The startup resume path reads
 *  the same task file and continues after the restart. */

import type { SdkMcpToolDefinition } from '@anthropic-ai/claude-agent-sdk'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import type { EvolveScheduleInput } from './evolve-store'

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface EvolveBridge {
  /** True only while this conversation is in the selfEvolve approval tier. */
  enabled: () => boolean
  schedule: (input: EvolveScheduleInput) => Promise<unknown>
  status: () => Promise<unknown>
  /** 用户点叉时返回 cancelled；waiting 表示等当前回合结束后再重启。 */
  restart: (version?: string) => Promise<{ scheduled: boolean; waiting?: boolean; cancelled?: boolean; note?: string; version?: string }>
}

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function disabled(): ToolResult {
  return fail('只有「自我进化」审批模式可以使用这个工具。请让用户先在审批菜单里切换模式。')
}

export function createEvolveToolsServer(bridge: EvolveBridge) {
  const scheduleTool = {
    name: 'schedule',
    description: '安排重启后继续执行的一步：prompt 是重启后发给本对话的指令，command 是重启后在本机执行的命令，goal 是要跨重启保留的目标条件。可以同时给多项。只在用户要求自我更新、并已切到「自我进化」模式时使用。',
    inputSchema: {
      goal: z.string().optional().describe('重启后要继续的目标条件；会重新发送 /goal'),
      prompt: z.string().optional().describe('重启后发给本对话的指令'),
      command: z.string().optional().describe('重启后在应用工作目录执行的 shell 命令'),
      note: z.string().optional().describe('写进任务备注的说明')
    },
    handler: async (args: EvolveScheduleInput = {}) => {
      if (!bridge.enabled()) return disabled()
      try {
        return ok(await bridge.schedule(args))
      } catch (error) {
        return fail(error instanceof Error ? error.message : '任务没有保存。')
      }
    }
  }

  const statusTool = {
    name: 'status',
    description: '读取当前自我进化任务：状态、目标、待执行步骤和已执行结果。只在「自我进化」模式下可用。',
    inputSchema: {},
    handler: async () => {
      if (!bridge.enabled()) return disabled()
      try {
        return ok(await bridge.status())
      } catch (error) {
        return fail(error instanceof Error ? error.message : '任务状态读取失败。')
      }
    }
  }

  const restartTool = {
    name: 'restart',
    description: '保存当前自我进化任务并重启应用。等当前回合结束后执行；可以传 version 切到已经打包好的 release 版本（例如 0.0.88）。自我更新前先用 Bash 运行 npm run pack:release 生成新版本，再传版本号。只在用户明确要求自我更新、并已切到「自我进化」模式时使用。',
    inputSchema: {
      version: z.string().optional().describe('要启动的发布版本号，例如 0.0.88；不传则重启当前版本')
    },
    handler: async (args: { version?: unknown } = {}) => {
      if (!bridge.enabled()) return disabled()
      const version = typeof args.version === 'string' ? args.version.trim() : ''
      if (version && !/^\d+\.\d+\.\d+$/.test(version)) return fail('版本号应形如 0.0.88。')
      try {
        return ok(await bridge.restart(version || undefined))
      } catch (error) {
        return fail(error instanceof Error ? error.message : '重启没有安排成功。')
      }
    }
  }

  return createSdkMcpServer({
    name: 'evolve',
    version: '1.0.0',
    instructions: '自我进化任务：schedule 安排重启后继续的指令/命令/目标，status 查看进度，restart 保存并重启。只在「自我进化」审批模式下使用；不要把无关的普通任务塞进这里。',
    tools: [scheduleTool, statusTool, restartTool] as unknown as Array<SdkMcpToolDefinition>
  })
}
