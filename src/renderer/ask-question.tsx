import { useState } from 'react'
import type { AskAnswers, AskQuestion, AskQuestionRequest } from '../shared/contracts'

/** Picked labels × free text, one entry per answered question — the exact shape
 *  the CLI reads back from updatedInput.answers. Free text wins a single-choice
 *  question and joins the labels on a multiSelect one; unanswered questions are
 *  left out entirely. */
export function composeAnswers(questions: AskQuestion[], picked: Record<string, string[]>, custom: Record<string, string>): AskAnswers {
  const answers: AskAnswers = {}
  for (const question of questions) {
    const free = (custom[question.key] ?? '').trim()
    const choices = picked[question.key] ?? []
    if (question.multiSelect) {
      const list = free ? [...choices, free] : choices
      if (list.length) answers[question.key] = list
    } else if (free) {
      answers[question.key] = free
    } else if (choices.length) {
      answers[question.key] = choices[0]
    }
  }
  return answers
}

/**
 * The parked AskUserQuestion, shown where the composer usually sits — laid out
 * like Claudian's panel: one question per tab ("Q1"/header), a green tick once
 * a question is answered, single-choice picks advance on their own, and a final
 * review tab lists every question with its answer (click one to jump back and
 * edit) before 回答 submits. A single question skips the tabs and answers
 * straight from its options. Options are borderless rows with a radio/checkbox
 * mark, every question keeps an "其他…" line, and 跳过 declines the whole call.
 */
export function AskQuestionPanel({ request, onSubmit, onSkip }: {
  request: AskQuestionRequest
  onSubmit: (answers: AskAnswers) => Promise<boolean>
  onSkip: () => Promise<boolean>
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [tab, setTab] = useState(0)
  const [busy, setBusy] = useState(false)

  const total = request.questions.length
  const multi = total > 1
  const review = multi && tab >= total
  const question = request.questions[Math.min(tab, total - 1)]

  const answers = composeAnswers(request.questions, picked, custom)
  const ready = request.questions.every((item) => item.key in answers)
  const free = (custom[question.key] ?? '').trim()
  const chosen = picked[question.key] ?? []

  function pick(label: string): void {
    setPicked((current) => {
      const choices = current[question.key] ?? []
      const next = question.multiSelect
        ? choices.includes(label) ? choices.filter((item) => item !== label) : [...choices, label]
        : [label]
      return { ...current, [question.key]: next }
    })
    // A single choice is a decision: it replaces any own answer, and with more
    // than one question it also moves on — next question, or the review tab.
    if (!question.multiSelect) {
      setCustom((current) => ({ ...current, [question.key]: '' }))
      if (multi) setTab(tab + 1)
    }
  }

  function typeFree(value: string): void {
    setCustom((current) => ({ ...current, [question.key]: value }))
    // An own answer replaces a single choice; multi-select folds it in.
    if (!question.multiSelect && value.trim()) {
      setPicked((current) => ({ ...current, [question.key]: [] }))
    }
  }

  async function submit(): Promise<void> {
    if (busy || !ready) return
    setBusy(true)
    if (!await onSubmit(answers)) setBusy(false)
  }

  async function skip(): Promise<void> {
    if (busy) return
    setBusy(true)
    if (!await onSkip()) setBusy(false)
  }

  return <div className="panel-ask" aria-label="等待回答的问题">
    {multi && <nav className="panel-ask-tabs" role="tablist" aria-label="问题导航">
      {request.questions.map((item, index) => {
        const done = item.key in answers
        return <button key={item.key} type="button" role="tab" aria-selected={!review && index === tab}
          className={`panel-ask-tab${!review && index === tab ? ' is-active' : ''}${done ? ' is-answered' : ''}`}
          title={item.question} onClick={() => setTab(index)}>
          <span className="panel-ask-tick" aria-hidden="true">{done ? '✓' : ''}</span>
          <span className="panel-ask-tab-label">{item.header ? item.header.slice(0, 12) : `Q${index + 1}`}</span>
        </button>
      })}
      <button type="button" role="tab" aria-selected={review}
        className={`panel-ask-tab panel-ask-tab-submit${review ? ' is-active' : ''}${ready ? ' is-ready' : ''}`}
        onClick={() => setTab(total)}>提交</button>
    </nav>}
    {review ? <section className="panel-ask-review" aria-label="确认回答">
      <span className="panel-ask-review-title">确认回答</span>
      <div className="panel-ask-review-list">
        {request.questions.map((item, index) => {
          const value = answers[item.key]
          const text = value === undefined ? null : Array.isArray(value) ? value.join('、') : value
          return <button key={item.key} type="button" className="panel-ask-review-pair" aria-label={`修改此题的答案：${item.question}`} onClick={() => setTab(index)}>
            <span className="panel-ask-review-q">{item.question}</span>
            <span className={text === null ? 'panel-ask-review-empty' : 'panel-ask-review-a'}>{text ?? '未回答'}</span>
          </button>
        })}
      </div>
    </section> : <section className="panel-ask-block">
      {question.header && <span className="panel-ask-header">{question.header}</span>}
      <p className="panel-ask-text">{question.question}</p>
      <div className="panel-ask-options" role={question.multiSelect ? 'group' : 'radiogroup'} aria-label={question.question}>
        {question.options.map((option) => {
          const active = chosen.includes(option.label)
          return <button key={option.label} type="button" role={question.multiSelect ? 'checkbox' : 'radio'} aria-checked={active}
            className={`panel-ask-option${active ? ' is-picked' : ''}`} onClick={() => pick(option.label)}>
            <span className={`panel-ask-mark panel-ask-mark-${question.multiSelect ? 'check' : 'radio'}`} aria-hidden="true" />
            <span className="panel-ask-option-text"><span className="panel-ask-option-label">{option.label}</span>{option.description && <small>{option.description}</small>}</span>
          </button>
        })}
        <label className={`panel-ask-option panel-ask-custom${free ? ' is-picked' : ''}`}>
          <span className={`panel-ask-mark panel-ask-mark-${question.multiSelect ? 'check' : 'radio'}`} aria-hidden="true" />
          <input className="panel-ask-other" value={custom[question.key] ?? ''} aria-label={`${question.question} 的其他答案`} placeholder="其他…"
            onChange={(event) => typeFree(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (multi) setTab(tab + 1); else void submit() } }} />
        </label>
      </div>
    </section>}
    {(review || !multi) && <div className="panel-ask-actions">
      <button type="button" className="panel-ask-skip" disabled={busy} onClick={() => { void skip() }}>跳过</button>
      <button type="button" className="panel-ask-submit" disabled={busy || !ready} onClick={() => { void submit() }}>{busy ? '发送中…' : '回答'}</button>
    </div>}
  </div>
}
