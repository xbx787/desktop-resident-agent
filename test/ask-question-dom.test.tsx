// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { AskQuestionPanel } from '../src/renderer/ask-question'
import type { AskAnswers, AskQuestionRequest } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request: AskQuestionRequest = {
  id: 'r1',
  questions: [
    { key: 'q1', question: '用哪种方案？', options: [{ label: '甲' }, { label: '乙' }], multiSelect: false },
    { key: 'q2', question: '还要什么？', options: [{ label: '日志' }, { label: '测试' }], multiSelect: true }
  ]
}

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function mount(onSubmit: (answers: AskAnswers) => Promise<boolean>, onSkip: () => Promise<boolean>,
  ask: AskQuestionRequest = request): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<AskQuestionPanel request={ask} onSubmit={onSubmit} onSkip={onSkip} />))
  return container
}

describe('AskQuestionPanel interactions', () => {
  it('advances on a single choice, ticks the tab, and submits from the review tab', async () => {
    const submitted: AskAnswers[] = []
    const view = await mount(async (answers) => { submitted.push(answers); return true }, async () => true)
    expect(view.textContent).toContain('用哪种方案？')
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    // A single choice moves on by itself — first to the next question.
    expect(view.textContent).not.toContain('用哪种方案？')
    expect(view.textContent).toContain('还要什么？')
    const tabs = view.querySelectorAll('.panel-ask-tab')
    expect(tabs[0].textContent).toContain('✓')
    expect(tabs[1].getAttribute('aria-selected')).toBe('true')
    // Multi-select stays put until the pick list is done.
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    expect(view.textContent).toContain('还要什么？')
    expect(tabs[1].textContent).toContain('✓')
    // The last tab is the review; every answer is on it.
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    expect(view.textContent).toContain('确认回答')
    expect(view.textContent).toContain('甲')
    expect(view.textContent).toContain('日志')
    await act(async () => click(view.querySelector('.panel-ask-submit')!))
    expect(submitted).toEqual([{ q1: '甲', q2: ['日志'] }])
  })

  it('keeps every answer one click away: tabs jump back and review pairs reopen their question', async () => {
    const view = await mount(async () => true, async () => true)
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[0]))
    expect(view.textContent).toContain('用哪种方案？')
    expect(view.querySelectorAll('.panel-ask-option')[0].getAttribute('aria-checked')).toBe('true')
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[1]))
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    expect(view.textContent).toContain('乙')
    await act(async () => click(view.querySelectorAll('.panel-ask-review-pair')[1]))
    expect(view.textContent).toContain('还要什么？')
    expect(view.textContent).not.toContain('确认回答')
  })

  it('folds own answers in: typing replaces a single choice and joins multi-select picks', async () => {
    const submitted: AskAnswers[] = []
    const view = await mount(async (answers) => { submitted.push(answers); return true }, async () => true)
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[0]))
    await act(async () => type(view.querySelector('.panel-ask-other') as HTMLInputElement, ' 丙 '))
    // Typing an own answer replaces the picked label.
    expect(view.querySelectorAll('.panel-ask-option')[0].getAttribute('aria-checked')).toBe('false')
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    expect(view.textContent).toContain('丙')
    await act(async () => click(view.querySelectorAll('.panel-ask-review-pair')[1]))
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    await act(async () => type(view.querySelector('.panel-ask-other') as HTMLInputElement, ' 别的 '))
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    await act(async () => click(view.querySelector('.panel-ask-submit')!))
    expect(submitted).toEqual([{ q1: '丙', q2: ['日志', '别的'] }])
  })

  it('lists unanswered entries in the review and lets 跳过 decline the whole call', async () => {
    let skipped = 0
    const view = await mount(async () => true, async () => { skipped += 1; return true })
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    expect(view.textContent).toContain('未回答')
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => click(view.querySelector('.panel-ask-skip')!))
    expect(skipped).toBe(1)
  })

  it('re-enables the buttons when a submit fails', async () => {
    const view = await mount(async () => false, async () => true)
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    await act(async () => click(view.querySelectorAll('.panel-ask-tab')[2]))
    await act(async () => click(view.querySelector('.panel-ask-submit')!))
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(false)
    expect((view.querySelector('.panel-ask-skip') as HTMLButtonElement).disabled).toBe(false)
  })

  it('keeps the single-question flow direct: no tabs, gated 回答, straight submit', async () => {
    const submitted: AskAnswers[] = []
    const view = await mount(async (answers) => { submitted.push(answers); return true }, async () => true,
      { id: 'r2', questions: [request.questions[0]] })
    expect(view.querySelector('.panel-ask-tabs')).toBeNull()
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => click(view.querySelectorAll('.panel-ask-option')[0]))
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => click(view.querySelector('.panel-ask-submit')!))
    expect(submitted).toEqual([{ q1: '甲' }])
  })

  it('填空题没有选项时只显示自定义输入，输入后可以提交', async () => {
    const submitted: AskAnswers[] = []
    const view = await mount(async (answers) => { submitted.push(answers); return true }, async () => true,
      { id: 'r3', questions: [{ key: 'q1', question: '给这个会话起个名字', options: [], multiSelect: false }] })
    expect(view.querySelectorAll('.panel-ask-option')).toHaveLength(1)
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(true)
    await act(async () => type(view.querySelector('.panel-ask-other') as HTMLInputElement, '开发一'))
    expect((view.querySelector('.panel-ask-submit') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => click(view.querySelector('.panel-ask-submit')!))
    expect(submitted).toEqual([{ q1: '开发一' }])
  })
})
