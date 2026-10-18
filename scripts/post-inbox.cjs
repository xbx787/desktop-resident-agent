#!/usr/bin/env node
/**
 * Drops one message into the app's inbox. The running app shows it in the
 * current conversation as a sender-labelled notice (no model turn).
 *
 *   node scripts/post-inbox.cjs --text "【来自对话「开发二」】…"
 *   node scripts/post-inbox.cjs --from "开发二" --badge "开" --text "…"
 */
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : ''
    out[key.slice(2)] = value
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const text = String(args.text || '').trim()
if (!text) {
  console.error('usage: post-inbox.cjs --text <message> [--from <name>] [--badge <char>] [--conversation <id>]')
  process.exit(2)
}
const fromName = String(args.from || '').trim()
const badge = String(args.badge || '').trim()
if ((fromName && !badge) || (!fromName && badge)) {
  console.error('--from and --badge must be supplied together.')
  process.exit(2)
}

// A source conversation title is the preferred identity; the app resolves it
// from its own library so the UI never relies on a caller-invented name.
let sourceConversationId
const sourceArg = String(args.source || '').trim()
if (sourceArg) {
  try {
    const library = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'conversations', 'library.json'), 'utf8'))
    const match = (library.conversations || []).find((item) => item.id === sourceArg || item.title === sourceArg)
    if (!match) throw new Error(`找不到来源对话：${sourceArg}`)
    sourceConversationId = match.id
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(2)
  }
}

const directory = path.join(process.cwd(), 'data', 'inbox')
fs.mkdirSync(directory, { recursive: true })
const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`
const target = path.join(directory, `${id}.json`)
const temporary = `${target}.tmp`
const payload = {
  ...(fromName ? { from: { name: fromName.slice(0, 40), badge: badge.slice(0, 2) } } : {}),
  text: text.slice(0, 8_000),
  ...(args.conversation ? { conversationId: String(args.conversation).slice(0, 80) } : {}),
  ...(sourceConversationId ? { sourceConversationId } : {})
}
fs.writeFileSync(temporary, JSON.stringify(payload, null, 2), 'utf8')
fs.renameSync(temporary, target)
console.log(`[inbox] queued ${id}`)
