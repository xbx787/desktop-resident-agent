import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

/** A small, closable input stream for one persistent Claude Agent SDK query. */
export class AgentMessageChannel implements AsyncIterable<SDKUserMessage> {
  private readonly messages: SDKUserMessage[] = []
  private waiter?: (message: SDKUserMessage | null) => void
  private closed = false

  enqueue(message: SDKUserMessage): void {
    if (this.closed) throw new Error('Claude Agent 输入通道已经关闭。')
    const waiter = this.waiter
    if (waiter) {
      this.waiter = undefined
      waiter(message)
    } else {
      this.messages.push(message)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.messages.length = 0
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.(null)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      const message = await this.next()
      if (!message) return
      yield message
    }
  }

  private next(): Promise<SDKUserMessage | null> {
    if (this.messages.length) return Promise.resolve(this.messages.shift()!)
    if (this.closed) return Promise.resolve(null)
    return new Promise((resolve) => { this.waiter = resolve })
  }
}
