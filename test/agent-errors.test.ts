import { describe, expect, it } from 'vitest'
import { AgentTurnError, classifyAgentFailure } from '../src/main/agent-errors'

describe('classifyAgentFailure', () => {
  it('recognizes a dead resume id and keeps the id for confirmation', () => {
    const failure = classifyAgentFailure(new Error('Error: No conversation found with session ID: 07f2e9d1-aaaa-4bbb-8ccc-1234567890ab'))
    expect(failure.kind).toBe('session-missing')
    expect(failure.missingSessionId).toBe('07f2e9d1-aaaa-4bbb-8ccc-1234567890ab')
    expect(failure.invalidatesSession).toBe(true)
  })

  it('names authentication, transport and process failures with stable sentences', () => {
    const auth = classifyAgentFailure(new Error('request failed with status 401 Unauthorized'))
    expect(auth.kind).toBe('authentication')
    expect(auth.invalidatesSession).toBe(false)
    expect(auth.message).toContain('API Key')

    const transport = classifyAgentFailure(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:7890'))
    expect(transport.kind).toBe('transport')
    expect(transport.invalidatesSession).toBe(true)
    expect(transport.message).toContain('网络或代理')

    const exited = classifyAgentFailure(new Error('Claude Code process exited with code 1'))
    expect(exited.kind).toBe('process-exited')
    expect(exited.invalidatesSession).toBe(true)

    // Our own "the stream just ended" sentence travels the same recovery path.
    expect(classifyAgentFailure(new Error('Claude Agent 会话意外结束。')).kind).toBe('process-exited')
  })

  it('treats launch trouble as configuration and keeps unknown text verbatim', () => {
    const missing = classifyAgentFailure(new Error('spawn C:\\nowhere\\claude.exe ENOENT'))
    expect(missing.kind).toBe('configuration')
    expect(missing.invalidatesSession).toBe(false)
    expect(missing.message).toContain('ENOENT')

    expect(classifyAgentFailure(new Error('There is an issue with the selected model')))
      .toEqual({ kind: 'unknown', message: 'There is an issue with the selected model', invalidatesSession: false })
    expect(classifyAgentFailure(undefined)).toMatchObject({ kind: 'unknown', invalidatesSession: false })
    expect(classifyAgentFailure('恢复的对话上下文用量不可用，且压缩未确认完成。').kind).toBe('unknown')
  })
})

describe('AgentTurnError', () => {
  it('surfaces the classified sentence as its message', () => {
    const error = new AgentTurnError(classifyAgentFailure(new Error('fetch failed')))
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('AgentTurnError')
    expect(error.message).toContain('连接 DeepSeek 失败')
    expect(error.failure.kind).toBe('transport')
  })
})
