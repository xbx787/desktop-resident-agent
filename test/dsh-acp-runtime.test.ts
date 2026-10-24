import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'

/** 最小的子进程替身：request 只用到 stdin.write，退出由测试手动触发。 */
function fakeChild() {
  const child = new EventEmitter() as any
  child.stdin = { write: vi.fn(), end: vi.fn() }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.killed = false
  child.kill = vi.fn()
  return child
}

function newRuntime() {
  return new DshAcpRuntime({ bin: 'x', home: 'x', cwd: 'x' })
}

describe('DshAcpRuntime pending isolation', () => {
  it('rejects only the requests of the process that exited', async () => {
    const runtime = newRuntime()
    const previous = fakeChild()
    ;(runtime as any).child = previous
    const previousRequest = runtime.request('old.method', {}).catch((error: Error) => error)

    const current = fakeChild()
    ;(runtime as any).child = current
    const currentRequest = runtime.request('new.method', {}).catch((error: Error) => error)

    ;(runtime as any).rejectPendingOf(previous, 'DSH ACP 已退出（1）')

    const previousResult = await previousRequest
    expect(previousResult).toBeInstanceOf(Error)
    expect((previousResult as Error).message).toContain('DSH ACP 已退出')

    // 新进程的请求必须还在等，不能被旧进程的退出清掉。
    expect((runtime as any).pending.size).toBe(1)
    ;(runtime as any).rejectPendingOf(current, 'cleanup')
    await currentRequest
  })

  it('drops late stdout lines from a replaced process', async () => {
    const runtime = newRuntime()
    const previous = fakeChild()
    ;(runtime as any).child = previous
    const previousRequest = runtime.request('old.method', {}).catch((error: Error) => error)
    const id = [...(runtime as any).pending.keys()][0] as string

    const current = fakeChild()
    ;(runtime as any).child = current
    // 旧进程迟到的一行结果：当前进程已经换了，必须丢弃。
    ;(runtime as any).handleLine(JSON.stringify({ jsonrpc: '2.0', id, result: { ok: true } }), previous)

    expect((runtime as any).pending.size).toBe(1)
    ;(runtime as any).rejectPendingOf(previous, 'cleanup')
    await previousRequest
  })
})
