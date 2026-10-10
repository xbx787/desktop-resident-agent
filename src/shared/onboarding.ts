/** Small pure helpers shared by the onboarding window and the main process:
 *  pasted API keys arrive with stray whitespace, quotes, or a `Bearer `
 *  prefix, and the wizard wants a soft read on the key's shape — never an
 *  authority; the connection test downstream is the verdict. */

export function normalizeApiKey(raw: string): string {
  let value = raw.trim()
  if (/^bearer\s+/iu.test(value)) value = value.replace(/^bearer\s+/iu, '')
  value = value.replace(/^["'`“”‘’]+/u, '').replace(/["'`“”‘’]+$/u, '').trim()
  return value
}

export type ApiKeyHint = 'empty' | 'suspicious' | 'good'

/** DeepSeek keys start with `sk-`; anything else gets a soft warning, never a
 *  block. */
export function apiKeyHint(raw: string): ApiKeyHint {
  const value = normalizeApiKey(raw)
  if (!value) return 'empty'
  return /^sk-[A-Za-z0-9_-]{8,}$/u.test(value) ? 'good' : 'suspicious'
}
