import { promises as fsp } from 'node:fs'
import path from 'node:path'
import type { ConversationController } from './conversation-controller'

export interface InboxMessage {
  /** Explicit sender, or absent when resolved from sourceConversationId. */
  from?: { name: string; badge: string }
  text: string
  /** Destination conversation; defaults to the currently displayed one. */
  conversationId?: string
  /** Source conversation; its title becomes the visible sender name. */
  sourceConversationId?: string
  /** true = deliver as a normal user message and start a model turn.
   *  false/absent keeps the original passive-notice behaviour. */
  autoRun?: boolean
}

/** Validates one inbox file. Files are local data, never instructions. */
export function parseInboxMessage(raw: unknown): InboxMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  const source = record.from
  const fields = source && typeof source === 'object' && !Array.isArray(source)
    ? source as Record<string, unknown>
    : {}
  const text = typeof record.text === 'string' ? record.text.trim() : ''
  if (!text || text.length > 8_000) return null
  // The source title may arrive as `from`, or as the same prefix the
  // conversation-to-conversation tool already writes into the body.
  const prefixName = /^【来自对话「([^」]{1,40})」】/u.exec(text)?.[1]?.trim() ?? ''
  const name = (typeof fields.name === 'string' ? fields.name.trim().slice(0, 40) : '') || prefixName
  const badge = (typeof fields.badge === 'string' ? fields.badge.trim().slice(0, 2) : '') || name.slice(0, 1)
  const conversationId = typeof record.conversationId === 'string'
    ? record.conversationId.trim().slice(0, 80) : undefined
  const sourceConversationId = typeof record.sourceConversationId === 'string'
    ? record.sourceConversationId.trim().slice(0, 80) : undefined
  const autoRun = record.autoRun === true
  if (!name || !badge) {
    if (!sourceConversationId) return null
    return {
      text,
      ...(conversationId ? { conversationId } : {}),
      sourceConversationId,
      ...(autoRun ? { autoRun: true } : {})
    }
  }
  return {
    from: { name, badge },
    text,
    ...(conversationId ? { conversationId } : {}),
    ...(sourceConversationId ? { sourceConversationId } : {}),
    ...(autoRun ? { autoRun: true } : {})
  }
}

/** Watchers normally drop a message into the current conversation as a visible
 *  notice. An explicit `autoRun: true` opts into a normal queued user message
 *  instead, so an external scheduler can start a real model turn. */
export class InboxWatcher {
  private timer: ReturnType<typeof setInterval> | undefined
  private polling = false

  constructor(
    private readonly directory: string,
    private readonly controller: Pick<ConversationController, 'appendExternalMessage' | 'conversationSender' | 'sendMessage'>,
    private readonly intervalMs = 1_000
  ) {}

  start(): void {
    if (this.timer) return
    void fsp.mkdir(this.directory, { recursive: true }).catch(() => undefined)
    this.timer = setInterval(() => { void this.poll() }, this.intervalMs)
    void this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      let names: string[]
      try {
        names = (await fsp.readdir(this.directory)).filter((name) => name.endsWith('.json')).sort().slice(0, 10)
      } catch {
        return
      }
      for (const name of names) {
        const file = path.join(this.directory, name)
        try {
          const info = await fsp.stat(file)
          if (!info.isFile() || info.size > 64 * 1024) throw new Error('invalid inbox item')
          const message = parseInboxMessage(JSON.parse(await fsp.readFile(file, 'utf8')))
          if (!message) throw new Error('invalid inbox item')
          const resolved = message.sourceConversationId
            ? this.controller.conversationSender(message.sourceConversationId)
            : undefined
          const from = resolved ?? message.from
          if (!from) throw new Error('unknown inbox sender')
          if (message.autoRun) {
            // A normal user message: it starts a turn, shows in the transcript,
            // and produces a reply. Meant for schedulers and self-evolution.
            // The prefix is rendered as a sender badge instead of prose.
            await this.controller.sendMessage(`【定时任务】\n${message.text}`, [], 'queue', message.conversationId)
          } else {
            await this.controller.appendExternalMessage(message.text, from, message.conversationId)
          }
          await fsp.unlink(file)
        } catch {
          // Keep bad items for inspection instead of retrying them forever.
          await fsp.rename(file, `${file}.failed`).catch(() => undefined)
        }
      }
    } finally {
      this.polling = false
    }
  }
}
