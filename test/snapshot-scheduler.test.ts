import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotScheduler } from '../src/main/snapshot-scheduler'

describe('snapshot scheduler', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends the first change immediately', () => {
    const sent: string[] = []
    const scheduler = createSnapshotScheduler(() => sent.push('a'), 50)
    scheduler.publish()
    expect(sent).toEqual(['a'])
  })

  it('collapses a streaming burst into one trailing send that carries the latest state', () => {
    const snapshots: string[] = []
    let state = 'a'
    const scheduler = createSnapshotScheduler(() => snapshots.push(state), 50)

    scheduler.publish()
    for (const next of ['b', 'c', 'd', 'e']) {
      state = next
      scheduler.publish()
    }
    expect(snapshots).toEqual(['a'])

    vi.advanceTimersByTime(49)
    expect(snapshots).toEqual(['a'])
    vi.advanceTimersByTime(1)
    expect(snapshots).toEqual(['a', 'e'])
  })

  it('keeps a fixed cadence while deltas keep arriving, and still flushes the last one', () => {
    let sends = 0
    const scheduler = createSnapshotScheduler(() => { sends += 1 }, 50)
    // 390 deltas, one per millisecond: without coalescing this would be 390 sends.
    // The loop stops mid-interval, so one trailing send is still owed afterwards.
    for (let tick = 0; tick < 390; tick += 1) {
      scheduler.publish()
      vi.advanceTimersByTime(1)
    }
    const duringBurst = sends
    expect(duringBurst).toBeGreaterThan(1)
    expect(duringBurst).toBeLessThanOrEqual(10)

    vi.advanceTimersByTime(50)
    expect(sends).toBe(duringBurst + 1)
  })

  it('does not send twice when an explicit flush supersedes the pending slot', () => {
    const sent: string[] = []
    const scheduler = createSnapshotScheduler(() => sent.push('x'), 50)
    scheduler.publish()
    scheduler.publish()
    vi.advanceTimersByTime(10)
    scheduler.flush()
    expect(sent).toEqual(['x', 'x'])
    vi.advanceTimersByTime(100)
    expect(sent).toEqual(['x', 'x'])
  })
})
