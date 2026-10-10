import { describe, expect, it } from 'vitest'
import { formatSelectionQuote } from '../src/renderer/message-quote'

describe('formatSelectionQuote', () => {
  it('prefixes every line and normalizes CRLF', () => {
    expect(formatSelectionQuote('第一行\r\n第二行')).toBe('> 第一行\n> 第二行')
  })

  it('keeps blank lines as bare markers and preserves indentation', () => {
    expect(formatSelectionQuote('代码：\n    const x = 1\n\n结束')).toBe('> 代码：\n>     const x = 1\n>\n> 结束')
  })

  it('leaves an empty selection empty', () => {
    expect(formatSelectionQuote('')).toBe('')
    expect(formatSelectionQuote('   ')).toBe('')
  })
})
