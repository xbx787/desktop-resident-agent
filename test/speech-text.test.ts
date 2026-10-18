import { describe, expect, it } from 'vitest'
import { estimateSpeechSegments, segmentForSpeech, stripMarkdownForSpeech } from '../src/shared/speech-text'

describe('speech text', () => {
  it('drops code and keeps readable prose', () => {
    const text = [
      '# 标题',
      '',
      '第一句。`行内代码`保留文字。',
      '',
      '```ts',
      'const hidden = true',
      '```',
      '',
      '- 列表项一',
      '- [链接文字](https://example.com)',
      '',
      '| 列一 | 列二 |',
      '| --- | --- |',
      '| 甲 | 乙 |'
    ].join('\n')
    const clean = stripMarkdownForSpeech(text)
    expect(clean).not.toContain('const hidden')
    expect(clean).not.toContain('#')
    expect(clean).not.toContain('|')
    expect(clean).toContain('标题')
    expect(clean).toContain('行内代码')
    expect(clean).toContain('链接文字')
    expect(clean).toContain('列一，列二')
  })

  it('merges short sentences and hard-splits a long one', () => {
    const short = segmentForSpeech('你好。今天讲三个部分。第一，函数。第二，极限。')
    expect(short.length).toBe(1)
    expect(short[0].text).toContain('三个部分')

    const long = segmentForSpeech('字'.repeat(450), 100)
    expect(long.length).toBe(5)
    expect(long.every((part) => part.text.length <= 100)).toBe(true)
  })

  it('returns nothing for empty or code-only input', () => {
    expect(segmentForSpeech('')).toEqual([])
    expect(segmentForSpeech('```\nonly code\n```')).toEqual([])
    expect(estimateSpeechSegments('')).toBe(0)
  })
})
