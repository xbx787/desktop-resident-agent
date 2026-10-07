// 语音诊断日志：写到磁盘文件，方便运行中实例排查
import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

let logPath: string | undefined

export function getVoiceLogPath(): string | undefined {
  if (logPath) return logPath
  try {
    const dir = path.join(app.getAppPath(), 'logs')
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    logPath = path.join(dir, 'asr.log')
    // 启动时清空旧日志
    fs.writeFileSync(logPath, `[${new Date().toISOString()}] voice log start\n`)
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
    const p = logPath ?? getVoiceLogPath()
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
    const p = logPath ?? getVoiceLogPath()
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
