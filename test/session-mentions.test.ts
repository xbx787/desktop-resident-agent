import { describe, expect, it } from 'vitest'
import { parseSessionMentions, sessionMentionToken } from '../src/shared/session-mentions'

const id = '6e2dfe3c-f0ec-4b73-92aa-5ffec9b87780'

describe('session mention tokens', () => {
  it('keeps a readable title and resolves by a stable ID', () => {
    const token = sessionMentionToken('计划 [初稿] \\ 版本', id)
    expect(token).toContain('xiaojing-session:' + id)
    expect(parseSessionMentions(`参考 ${token}`)).toEqual([{ id, title: '计划 [初稿] \\ 版本' }])
  })

  it('ignores code examples and rejects malformed IDs in prose', () => {
    const token = sessionMentionToken('旧会话', id)
    expect(parseSessionMentions(`\`${token}\`\n\`\`${token}\`\`\n~~~\n${token}\n~~~\n\\${token}`)).toEqual([])
    expect(() => parseSessionMentions('@[旧会话](xiaojing-session:not-an-id)')).toThrow('编号无效')
    expect(() => parseSessionMentions('@[旧会话](xiaojing-session:')).toThrow('格式无效')
  })

  it('keeps language-tagged backtick fences inside code until a plain closing fence', () => {
    const token = sessionMentionToken('旧会话', id)
    const message = ['```markdown', '```js', token, '```', `正式引用 ${token}`].join('\n')
    expect(parseSessionMentions(message)).toEqual([{ id, title: '旧会话' }])
  })

  it('requires a matching closing character, sufficient length and whitespace-only tail', () => {
    const token = sessionMentionToken('旧会话', id)
    const message = ['   ~~~~ markdown', '~~~', '```', '~~~~ trailing', token, '   ~~~~ \t', token].join('\n')
    expect(parseSessionMentions(message)).toEqual([{ id, title: '旧会话' }])
  })

  it('does not open a backtick fence with a backtick in its info string', () => {
    const token = sessionMentionToken('旧会话', id)
    expect(parseSessionMentions(['```js`invalid', token].join('\n'))).toEqual([{ id, title: '旧会话' }])
  })
})
