import { describe, expect, it } from 'vitest'
import { DshAcpRuntime } from '../src/main/dsh-acp-runtime'

function runtime(): DshAcpRuntime {
  return new DshAcpRuntime({ bin: 'unused', home: process.cwd(), cwd: process.cwd() })
}

describe('ACP 透明重连', () => {
  it('在还没有会话通知时重启进程、恢复会话并重放 prompt', async () => {
    const acp = runtime()
    let prompts = 0
    let starts = 0
    let resumes = 0
    Object.assign(acp, {
      request: async (method: string) => {
        if (method !== 'session/prompt') return {}
        prompts += 1
        if (prompts === 1) throw new Error('DSH ACP 已退出（unknown）')
        return { stopReason: 'end_turn' }
      },
      close: async () => undefined,
      start: async () => { starts += 1 },
      resumeSession: async () => { resumes += 1; return { sessionId: 's' } }
    })
    await expect(acp.prompt('s', [])).resolves.toEqual({ stopReason: 'end_turn' })
    expect(prompts).toBe(2)
    expect(starts).toBe(1)
    expect(resumes).toBe(1)
  })

  it('已经产生通知时不重放，避免重复回答', async () => {
    const acp = runtime()
    const internals = acp as unknown as { activitySerial: number }
    Object.assign(acp, {
      request: async () => {
        internals.activitySerial += 1
        throw new Error('DSH ACP 已退出（unknown）')
      }
    })
    await expect(acp.prompt('s', [])).rejects.toThrow('自动恢复没有成功')
  })
})
