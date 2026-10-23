/** 库条目的健康检查：只回答“这个东西现在能不能启动”，不真正拉起 MCP。
 *
 *  - stdio MCP：检查命令在 PATH 或绝对路径上是否存在；
 *  - HTTP MCP：发一次 GET，能返回任意 HTTP 响应就算服务活着；
 *  - 技能/插件：检查安装目录是否还在。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { LibraryItem } from '../shared/libraries'

export interface LibraryHealth {
  ok: boolean
  message: string
}

function resolveCommand(command: string): string | null {
  if (path.isAbsolute(command)) return existsSync(command) ? command : null
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', '.com', ''] : ['']
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

export async function probeLibrary(item: LibraryItem, timeoutMs = 4_000): Promise<LibraryHealth> {
  if (item.disabled) return { ok: true, message: '已停用，不会注入会话。' }
  if (item.kind === 'skill' || item.kind === 'plugin') {
    return item.path && existsSync(item.path)
      ? { ok: true, message: '安装目录存在。' }
      : { ok: false, message: '安装目录不存在，请重新安装。' }
  }
  const launch = item.launch
  if (!launch) return { ok: false, message: '这个条目没有启动配置。' }
  if (launch.url) {
    if (!/^https?:\/\//iu.test(launch.url)) return { ok: false, message: 'MCP 地址不是 http/https。' }
    try {
      const response = await fetch(launch.url, { signal: AbortSignal.timeout(timeoutMs) })
      return response.status < 500
        ? { ok: true, message: `服务已响应（HTTP ${response.status}）。` }
        : { ok: false, message: `服务返回 HTTP ${response.status}。` }
    } catch {
      return { ok: false, message: `无法连接 ${launch.url}。` }
    }
  }
  if (!launch.command) return { ok: false, message: '这个 MCP 没有命令或地址。' }
  return resolveCommand(launch.command)
    ? { ok: true, message: `命令可用：${launch.command}` }
    : { ok: false, message: `找不到命令：${launch.command}` }
}
