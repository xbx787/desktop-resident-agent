/** Keys that answer "what is this call acting on?", most specific first.
 *  `description` leads: when a call carries one (our Bash calls do), it reads
 *  clearer after the row's label than the raw command does. */
const argumentKeys = ['description', 'command', 'file_path', 'pattern', 'path', 'query', 'url', 'plan', 'prompt', 'notebook_path', 'glob'];

function flatten(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}



/**
 * One readable line describing the object of a tool call — the command, the file,
 * the pattern — for the tool row's header. The complete input is formatted
 * separately in the expanded tool card.
 */
/** The plan text of an ExitPlanMode call. It lives in the call's input, not in
 *  its output ("User approved…"), so the row body reads it from here. */
export function toolPlanText(name: string, input: string | undefined): string {
  if (name.trim().toLowerCase() !== 'exitplanmode') return '';
  const trimmed = input?.trim() ?? '';
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const plan = (parsed as Record<string, unknown>).plan;
      if (typeof plan === 'string') return plan.trim();
    }
  } catch { /* fall through to nothing */ }
  return '';
}

export function toolArgumentPreview(input: string | undefined): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const key of argumentKeys) {
        const value = record[key];
        if (typeof value !== 'string' || !value.trim()) continue;
        const text = flatten(value);
        return text;
      }
      const first = Object.values(record).find((value) => typeof value === 'string' && value.trim());
      if (typeof first === 'string') return flatten(first);
      // Nothing but blank strings means there is nothing worth showing.
      const hasContent = Object.values(record).some((value) => typeof value !== 'string' || value.trim().length > 0);
      return hasContent ? flatten(JSON.stringify(record)) : '';
    }
    return flatten(typeof parsed === 'string' ? parsed : JSON.stringify(parsed));
  } catch {
    // Not JSON: the raw text is already the best description there is.
    return flatten(trimmed);
  }
}

/** Preserve the complete call input while making structured arguments readable. */
export function toolArgumentDetails(input: string | undefined): string {
  const trimmed = input?.trim() ?? '';
  if (!trimmed) return '';
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
  } catch {
    return trimmed;
  }
}
