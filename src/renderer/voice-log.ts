// 语音诊断日志：同步写到磁盘文件，方便运行中实例排查
import { app } from 'electron'

let logPath: string | undefined

function getLogPath(): string | undefined {
  if (logPath) return logPath
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const path = require('node:path') as typeof import('node:path')
    const dir = path.join(app.getAppPath(), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'asr.log')
    // 清空旧日志
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] log start\n`)
  } catch {
    logPath = undefined
  }
  return logPath
}

export function voiceLog(message: string, data?: unknown): void {
  const line = `[${new Date().toISOString()}] ${message}${data !== undefined ? ' ' + safeStringify(data) : ''}\n`
  try {
    console.log(message, data ?? '')
  } catch {
    // ignore
  }
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const p = getLogPath()
    if (p) fs.appendFileSync(p, line)
  } catch {
    // ignore
  }
}

export function voiceLogError(message: string, error: unknown): void {
  const errLine = `[${new Date().toISOString()}] ERROR ${message} ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : safeStringify(error)}\n`
  try {
    console.error(message, error)
  } catch {
    // ignore
  }
  try {
    const fs = require('node:fs') as typeof import('node:fs')
    const p = getLogPath()
    if (p) fs.appendFileSync(p, errLine)
  } catch {
    // ignore
  }
}

function safeStringify(data: unknown): string {
  try {
    if (data instanceof Error) return `${data.message}\n${data.stack ?? ''}`
    return JSON.stringify(data, null, 0)
  } catch {
    return String(data)
  }
}
