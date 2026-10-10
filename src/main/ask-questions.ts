import type { AskAnswers, AskQuestion } from '../shared/contracts'

/** Defensive parse of the AskUserQuestion tool input. Only well-formed questions
 *  survive; an empty list means there is nothing to ask (or the call is handled
 *  elsewhere). The answer key is the question id when the CLI provides one, the
 *  question text otherwise — the same key the CLI matches answers back with. */
export function parseAskQuestions(input: unknown): AskQuestion[] {
  if (!input || typeof input !== 'object') return []
  const raw = (input as { questions?: unknown }).questions
  if (!Array.isArray(raw)) return []
  const questions: AskQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const text = typeof record.question === 'string' ? record.question.trim() : ''
    if (!text) continue
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option) => {
          if (!option || typeof option !== 'object') return []
          const { label, description } = option as Record<string, unknown>
          if (typeof label !== 'string' || !label.trim()) return []
          return [{
            label: label.trim(),
            ...(typeof description === 'string' && description.trim() ? { description: description.trim() } : {})
          }]
        })
      : []
    questions.push({
      key: typeof record.id === 'string' && record.id ? record.id : text,
      question: text,
      header: typeof record.header === 'string' && record.header.trim() ? record.header.trim() : undefined,
      options,
      multiSelect: record.multiSelect === true
    })
  }
  return questions
}

/** IPC-side shape check for answers coming back from the panel: null (skip) or
 *  a map of labels / label arrays. */
export function isAskAnswers(value: unknown): value is AskAnswers {
  if (value === null) return true
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.values(value as Record<string, unknown>).every((entry) =>
    typeof entry === 'string' ||
    (Array.isArray(entry) && entry.every((item) => typeof item === 'string')))
}
