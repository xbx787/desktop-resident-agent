import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isAskAnswers, parseAskQuestions } from '../src/main/ask-questions'
import { AskQuestionPanel, composeAnswers } from '../src/renderer/ask-question'
import type { AskQuestion } from '../src/shared/contracts'

const questions: AskQuestion[] = [
  { key: 'q1', question: '用哪种方案？', header: '方案', options: [{ label: '甲' }, { label: '乙' }], multiSelect: false },
  { key: 'q2', question: '还要什么？', options: [{ label: '日志' }, { label: '测试' }], multiSelect: true }
]

describe('parseAskQuestions', () => {
  it('keeps well-formed questions and derives the answer key id-first', () => {
    const parsed = parseAskQuestions({
      questions: [
        { id: 'abc', question: ' 用哪种方案？ ', header: ' 方案 ', multiSelect: false, options: [{ label: '甲', description: ' 快 ' }, { label: '' }, { label: '乙' }] },
        { question: '还要什么？', options: 'bad', multiSelect: true }
      ]
    })
    expect(parsed).toEqual([
      { key: 'abc', question: '用哪种方案？', header: '方案', options: [{ label: '甲', description: '快' }, { label: '乙' }], multiSelect: false },
      { key: '还要什么？', question: '还要什么？', header: undefined, options: [], multiSelect: true }
    ])
  })

  it('returns nothing for inputs it cannot ask about', () => {
    expect(parseAskQuestions(null)).toEqual([])
    expect(parseAskQuestions({ questions: 'nope' })).toEqual([])
    expect(parseAskQuestions({ questions: [null, 7, { question: '   ' }] })).toEqual([])
  })
})

describe('isAskAnswers', () => {
  it('accepts skip and label maps, rejects everything else', () => {
    expect(isAskAnswers(null)).toBe(true)
    expect(isAskAnswers({ a: 'x', b: ['x', 'y'] })).toBe(true)
    expect(isAskAnswers({ a: 1 })).toBe(false)
    expect(isAskAnswers(['x'])).toBe(false)
    expect(isAskAnswers('x')).toBe(false)
  })
})

describe('composeAnswers', () => {
  it('picks labels for single choice and lets free text win', () => {
    expect(composeAnswers(questions, { q1: ['甲'] }, {})).toEqual({ q1: '甲' })
    expect(composeAnswers(questions, { q1: ['甲'] }, { q1: ' 丙 ' })).toEqual({ q1: '丙' })
  })

  it('collects multi-select labels and folds free text in', () => {
    expect(composeAnswers(questions, { q2: ['日志', '测试'] }, {})).toEqual({ q2: ['日志', '测试'] })
    expect(composeAnswers(questions, { q2: ['日志'] }, { q2: '别的' })).toEqual({ q2: ['日志', '别的'] })
  })

  it('leaves unanswered questions out entirely', () => {
    expect(composeAnswers(questions, {}, {})).toEqual({})
    expect(composeAnswers(questions, {}, { q1: '  ' })).toEqual({})
  })
})

describe('AskQuestionPanel', () => {
  const noop = async (): Promise<boolean> => true

  it('renders a tabbed panel: labelled tabs, option marks, the own-answer line and the review tab', () => {
    const html = renderToStaticMarkup(<AskQuestionPanel request={{ id: 'r1', questions }} onSubmit={noop} onSkip={noop} />)
    expect(html).toContain('panel-ask-tab')
    expect(html).toContain('方案')
    expect(html).toContain('Q2')
    expect(html).toContain('提交')
    expect(html).toContain('用哪种方案？')
    expect(html).toContain('甲')
    expect(html).toContain('panel-ask-mark-radio')
    expect(html).toContain('其他…')
    expect(html).toContain('aria-checked="false"')
  })

  it('shows one question at a time and keeps the actions off the question tab', () => {
    const html = renderToStaticMarkup(<AskQuestionPanel request={{ id: 'r1', questions }} onSubmit={noop} onSkip={noop} />)
    expect(html).toContain('用哪种方案？')
    expect(html).not.toContain('>还要什么？<')
    expect(html).not.toContain('确认回答')
    expect(html).not.toContain('跳过')
    expect(html).not.toContain('下一步')
    expect(html).not.toContain('上一步')
    expect(html).not.toContain('1 / 2')
  })

  it('answers a single question straight from its options, without tabs or review', () => {
    const html = renderToStaticMarkup(<AskQuestionPanel request={{ id: 'r1', questions: [questions[0]] }} onSubmit={noop} onSkip={noop} />)
    expect(html).not.toContain('panel-ask-tab')
    expect(html).not.toContain('确认回答')
    expect(html).toContain('跳过')
    expect(html).toMatch(/panel-ask-submit[^>]*disabled/)
    expect(html).toContain('panel-ask-mark-radio')
  })
})
