#!/usr/bin/env node
/**
 * Run a command (or watch an existing PID) and wait for a definite end
 * marker. The marker is written under data/task-watch/ so the caller does
 * not need a live terminal to learn that the process finished.
 *
 *   node scripts/run-and-watch.cjs --label "打包" --command "npm run pack:release"
 *   node scripts/run-and-watch.cjs --label "其他程序" --pid 12345
 */
const { spawn, execFile } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
    out[key.slice(2)] = value
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const label = String(args.label || 'task')
const command = typeof args.command === 'string' && args.command !== 'true' ? args.command : null
const pid = args.pid ? Number(args.pid) : null
const name = args.name && args.name !== 'true' ? String(args.name) : null
const timeoutSeconds = args.timeout ? Number(args.timeout) : null
const startedAt = Date.now()

if (!command && !Number.isFinite(pid) && !name) {
  console.error('usage: run-and-watch.cjs --label <name> (--command <cmd> | --pid <pid> | --name <exe>)')
  process.exit(2)
}

const safeLabel = label.replace(/[^\w一-龥-]+/gu, '_').slice(0, 40) || 'task'
const id = `${new Date(startedAt).toISOString().replace(/[:.]/gu, '-')}-${safeLabel}`
const markerDir = path.join(process.cwd(), 'data', 'task-watch')
const markerPath = path.join(markerDir, `${id}.json`)
let finished = false

function writeMarker(state, extra = {}, quiet = false) {
  try {
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(markerPath, JSON.stringify({
      id,
      label,
      command,
      pid: pid ?? undefined,
      state,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      markerPath,
      ...extra
    }, null, 2), 'utf8')
  } catch (error) {
    console.error('[watch] marker write failed:', error instanceof Error ? error.message : String(error))
  }
  if (!quiet) console.log(`[watch] marker=${markerPath}`)
}

function finish(state, extra = {}) {
  if (finished) return
  finished = true
  writeMarker(state, extra)
  const code = typeof extra.exitCode === 'number' ? extra.exitCode : state === 'exited' ? 0 : 1
  console.log(`[watch] ${label} ${state}${extra.exitCode !== undefined ? ` code=${extra.exitCode}` : ''}`)
  process.exit(code)
}

writeMarker('running', {}, true)

if (command) {
  const child = spawn(command, {
    shell: true,
    stdio: 'inherit',
    cwd: process.cwd(),
    windowsHide: true
  })
  let timer
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* ignore */ }
      finish('timeout', { exitCode: 124, timeoutSeconds })
    }, timeoutSeconds * 1000)
  }
  const stop = (signal) => {
    try { child.kill(signal) } catch { /* ignore */ }
    finish('cancelled', { signal })
  }
  process.once('SIGINT', () => stop('SIGINT'))
  process.once('SIGTERM', () => stop('SIGTERM'))
  child.once('error', (error) => {
    if (timer) clearTimeout(timer)
    finish('failed', { exitCode: 1, message: error.message })
  })
  child.once('close', (code, signal) => {
    if (timer) clearTimeout(timer)
    finish('exited', { exitCode: code ?? (signal ? 1 : 0), signal: signal ?? undefined })
  })
} else {
  const stillRunning = () => {
    if (Number.isFinite(pid)) {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM means the process exists but belongs to another user.
        return error && error.code === 'EPERM'
      }
    }
    return new Promise((resolve) => {
      execFile('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { windowsHide: true },
        (error, stdout) => resolve(!error && String(stdout).toLowerCase().includes(String(name).toLowerCase())))
    })
  }
  const poll = async () => {
    if (finished) return
    if (!(await stillRunning())) {
      finish('exited', { exitCode: 0 })
      return
    }
    setTimeout(poll, 500)
  }
  const timer = Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
    ? setTimeout(() => finish('timeout', { exitCode: 124, timeoutSeconds }), timeoutSeconds * 1000)
    : null
  process.once('SIGINT', () => { if (timer) clearTimeout(timer); finish('cancelled', { signal: 'SIGINT' }) })
  void poll()
}
