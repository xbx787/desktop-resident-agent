/** Stable conversation references keep the visible title readable while the
 * UUID, rather than a renameable title, identifies the source at submission. */
export interface SessionMention {
  id: string
  title: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const SCHEME = '](xiaojing-session:'

export function sessionMentionToken(title: string, id: string): string {
  if (!UUID.test(id)) throw new Error('会话编号无效。')
  const label = title.replace(/\s+/gu, ' ').trim().slice(0, 60) || '会话'
  return `@[${label.replace(/[\\\]]/gu, '\\$&')}](${SCHEME.slice(2)}${id})`
}

/** Tokens in Markdown code stay literal. A malformed Xiaojing token in prose
 * is an error, so a typo cannot silently turn a requested reference into text. */
export function parseSessionMentions(input: string): SessionMention[] {
  const mentions: SessionMention[] = []
  let fence: { marker: string; size: number } | null = null
  for (const line of input.split(/\r?\n/u)) {
    const fenceLine = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line)
    if (fence) {
      // A closing fence uses the same character, is at least as long, and
      // permits only spaces or tabs after it. ```js is code, not a close.
      if (fenceLine && fenceLine[1][0] === fence.marker && fenceLine[1].length >= fence.size &&
          /^[ \t]*$/u.test(fenceLine[2])) fence = null
      continue
    }
    // CommonMark forbids backticks in the info string of a backtick fence.
    if (fenceLine && (fenceLine[1][0] === '~' || !fenceLine[2].includes('`'))) {
      fence = { marker: fenceLine[1][0], size: fenceLine[1].length }
      continue
    }
    let inlineTicks = 0
    for (let i = 0; i < line.length;) {
      if (line[i] === '`') {
        let end = i + 1
        while (line[end] === '`') end += 1
        const size = end - i
        if (inlineTicks === 0) inlineTicks = size
        else if (inlineTicks === size) inlineTicks = 0
        i = end
        continue
      }
      if (inlineTicks || line[i] !== '@' || line[i + 1] !== '[' || line[i - 1] === '\\' ||
          (i > 0 && /[\p{L}\p{N}_@]/u.test(line[i - 1]))) { i += 1; continue }
      let labelEnd = i + 2
      while (labelEnd < line.length) {
        if (line[labelEnd] === '\\') { labelEnd += 2; continue }
        if (line[labelEnd] === ']') break
        labelEnd += 1
      }
      if (!line.startsWith(SCHEME, labelEnd)) { i += 2; continue }
      const idStart = labelEnd + SCHEME.length
      const close = line.indexOf(')', idStart)
      if (close < 0) throw new Error('会话引用格式无效，请重新从 @ 候选中选择。')
      const id = line.slice(idStart, close)
      if (!UUID.test(id)) throw new Error('会话引用编号无效，请重新从 @ 候选中选择。')
      const title = line.slice(i + 2, labelEnd).replace(/\\([\\\]])/gu, '$1')
      mentions.push({ id, title })
      i = close + 1
    }
  }
  return mentions
}
