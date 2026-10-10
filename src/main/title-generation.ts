/** Strips the decoration models love to add (wrapping quotes, a 「标题：」 prefix,
 *  trailing punctuation) and keeps the title to one short line. Returns null
 *  when nothing readable survives. */
export function cleanTitle(raw: string): string | null {
  const clean = raw
    .trim()
    .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/gu, '')
    .trim()
    .replace(/^(?:标题|题目)[：:]\s*/u, '')
    .replace(/^["'“”‘’「『《]+|["'“”‘’」』》]+$/gu, '')
    .replace(/[。.!！?？,，;；、：:]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 32)
    .trim()
  return clean || null
}

/** One-shot conversation titles: a single DeepSeek request with thinking off,
 *  based on the first user message only. A title is a nicety — every failure
 *  path returns null so the caller keeps its fallback, never an error. */
export async function generateConversationTitle(apiKey: string, source: string, signal?: AbortSignal): Promise<string | null> {
  const prompt = source.trim().slice(0, 500)
  if (!prompt) return null
  try {
    const response = await fetch('https://api.deepseek.com/responses', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        instructions: '你为一段对话起一个简短的中文标题：不超过 16 个字，不加引号或书名号，不以标点结尾，不写「标题：」这类前缀，只输出标题本身。',
        reasoning: { effort: 'none' },
        input: [{ role: 'user', content: `为下面这条消息起标题：\n${prompt}` }],
        max_output_tokens: 60
      }),
      signal
    })
    if (!response.ok) return null
    const data = (await response.json()) as { output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }
    const text = (data.output ?? [])
      .filter((item) => item.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
    return cleanTitle(text)
  } catch {
    return null
  }
}
