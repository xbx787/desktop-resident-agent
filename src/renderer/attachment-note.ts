export interface AttachmentNote {
  /** What the user actually wrote. */
  prompt: string
  /** The names the runtime appended, already joined by 、. */
  files: string
}

/**
 * The runtime records a user message with attachments as
 * `prompt\n附件：a、b`. The panel shows that tail under a divider of its own,
 * so the divider rule lives here rather than being guessed in the JSX.
 */
export function splitAttachmentNote(text: string): AttachmentNote | null {
  const match = /\n附件：([^\n]+)\s*$/u.exec(text)
  if (!match) return null
  const prompt = text.slice(0, match.index).trim()
  const files = match[1].trim()
  if (!files) return null
  return { prompt: prompt || '请阅读附件并帮助我。', files }
}

/** How one attachment name reads on its chip: `报告.docx` → badge `DOCX`
 *  with the stem `报告` beside it. Anything without a plain extension keeps
 *  its whole name and gets the generic badge. */
export function fileBadge(name: string): { kind: string; stem: string } {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1) : ''
  if (!/^[A-Za-z0-9]{1,5}$/u.test(extension)) return { kind: '文件', stem: name }
  return { kind: extension.toUpperCase(), stem: name.slice(0, dot) }
}
