/** Turns a selected passage into a markdown quote: every line gets a "> "
 *  prefix so the model (and the user) can tell quoted history apart from the
 *  new message. Blank lines become bare markers; indentation is preserved. */
export function formatSelectionQuote(text: string): string {
  if (!text.trim()) return ''
  return text
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) => (line.trim() ? `> ${line}` : '>'))
    .join('\n')
}
