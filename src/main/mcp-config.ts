import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null
}

/** Reuses the user's existing Windows MCP definition without copying credentials or modifying Claude Code. */
export function loadWindowsMcpConfig(configPath: string): Record<string, McpServerConfig> {
  let root: JsonObject | null
  try {
    root = object(JSON.parse(readFileSync(configPath, 'utf8')))
  } catch {
    return {}
  }
  const source = object(object(root?.mcpServers)?.['windows-mcp'])
  if (!source || (source.type !== undefined && source.type !== 'stdio')) return {}
  if (typeof source.command !== 'string' || !path.isAbsolute(source.command) || !existsSync(source.command)) return {}
  if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some((arg) => typeof arg !== 'string'))) return {}
  const rawEnv = source.env === undefined ? {} : object(source.env)
  if (!rawEnv || Object.values(rawEnv).some((value) => typeof value !== 'string')) return {}
  return {
    'windows-mcp': {
      type: 'stdio',
      command: source.command,
      args: (source.args ?? []) as string[],
      env: rawEnv as Record<string, string>
    }
  }
}
