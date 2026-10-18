/** Text preparation for speech. Pure functions: the same routine feeds chat
 *  replies and document-to-audio, so both read the same way. */

export interface SpeechSegment {
  index: number
  text: string
}

const FENCE = /```[\s\S]*?```/gu
const INLINE_CODE = /`([^`\n]+)`/gu
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK = /\[([^\]]+)\]\([^)]*\)/gu
const HTML = /<[^>]{1,200}>/gu
const TABLE_RULE = /^\s*\|?[\s:|-]{3,}\|?\s*$/gmu
const TABLE_ROW = /^\s*\|(.+)\|\s*$/gmu
const MARKDOWN_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gmu
const DECORATION = /(\*\*|__|~~|\*|_)/gu

/** Everything a listener should not hear: code, markup, table pipes. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(FENCE, '\n')
    .replace(INLINE_CODE, '$1')
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(TABLE_RULE, '')
    .replace(TABLE_ROW, (_match, cells: string) => `${cells.replace(/\s*\|\s*/gu, '，')}\n`)
    .replace(HTML, '')
    .replace(MARKDOWN_PREFIX, '')
    .replace(DECORATION, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function splitSentences(text: string): string[] {
  const parts: string[] = []
  let current = ''
  for (const char of text) {
    current += char
    if (/[。！？!?；;]/u.test(char)) {
      if (current.trim()) parts.push(current.trim())
      current = ''
    } else if (char === '\n') {
      if (current.trim()) parts.push(current.trim())
      current = ''
    }
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const chunks: string[] = []
  for (let start = 0; start < text.length; start += maxChars) {
    chunks.push(text.slice(start, start + maxChars))
  }
  return chunks
}

/** Sentence-aware segmentation with a hard cap. Short sentences are merged
 *  so the synthesizer receives natural paragraphs, not one word per request. */
export function segmentForSpeech(text: string, maxChars = 180): SpeechSegment[] {
  const limit = Math.max(20, Math.min(maxChars, 300))
  const clean = stripMarkdownForSpeech(text)
  if (!clean) return []
  const out: SpeechSegment[] = []
  let buffer = ''
  const flush = (): void => {
    const value = buffer.trim()
    if (value) out.push({ index: out.length, text: value })
    buffer = ''
  }
  for (const sentence of splitSentences(clean)) {
    for (const piece of splitLong(sentence, limit)) {
      if (buffer && buffer.length + piece.length > limit) flush()
      buffer = buffer ? `${buffer}${piece}` : piece
      if (buffer.length >= limit) flush()
    }
  }
  flush()
  return out
}

export function estimateSpeechSegments(text: string, maxChars = 180): number {
  return segmentForSpeech(text, maxChars).length
}
