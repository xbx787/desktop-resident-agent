import { describe, expect, it } from 'vitest'
import { publicErrorText } from '../src/shared/error-copy'

describe('public error copy', () => {
  it('removes vendor branding without touching unrelated text', () => {
    expect(publicErrorText('Claude Code process exited with code 1')).toBe('小鲸引擎 process exited with code 1')
    expect(publicErrorText('Claude Agent 运行失败。')).toBe('小鲸引擎 运行失败。')
    expect(publicErrorText('DeepSeek 认证失败：请检查 API Key。')).toBe('DeepSeek 认证失败：请检查 API Key。')
  })
})
