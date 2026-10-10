/** Coalesces a burst of state changes into a fixed-cadence stream of sends. */
export interface SnapshotScheduler {
  /** Sends now, or at the next cadence slot. A burst collapses into one trailing send. */
  publish(): void
  /** Sends immediately and cancels the pending slot, if any. */
  flush(): void
}

/**
 * A streaming turn emits one change per model delta. Forwarding each of them makes the
 * renderer re-render the whole panel per token, which starves its main thread until the
 * window stops reacting to clicks. Send at a fixed cadence instead, and always keep the
 * trailing send so the final state still lands.
 */
export function createSnapshotScheduler(send: () => void, intervalMs: number): SnapshotScheduler {
  let lastSentAt = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | undefined

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    lastSentAt = Date.now()
    send()
  }

  return {
    flush,
    publish(): void {
      const wait = lastSentAt + intervalMs - Date.now()
      if (wait <= 0) {
        flush()
        return
      }
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        flush()
      }, wait)
    }
  }
}
