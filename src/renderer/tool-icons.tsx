import type { ReactElement } from 'react'

/** Icon families a tool name can map to. Distinguishing them is what lets a long
 *  timeline be skimmed by shape instead of by reading every row. */
export type ToolIconKind = 'terminal' | 'document' | 'document-write' | 'pencil' | 'search' | 'agent' | 'globe' | 'checklist' | 'notebook' | 'link' | 'gear';

/** Most specific patterns first: "TodoWrite" must not fall through to the task
 *  branch, and "BashOutput" must reach the terminal rather than the document. */
const families: Array<{ kind: ToolIconKind; match: RegExp }> = [
  { kind: 'checklist', match: /todo|checklist/ },
  { kind: 'notebook', match: /notebook/ },
  { kind: 'globe', match: /web|fetch|http|browser|url/ },
  { kind: 'search', match: /grep|glob|search|find/ },
  { kind: 'terminal', match: /bash|shell|terminal|command|exec|kill|run/ },
  { kind: 'link', match: /mcp/ },
  { kind: 'agent', match: /task|agent|subagent/ },
  { kind: 'pencil', match: /edit|patch|replace|modify/ },
  { kind: 'document-write', match: /write|create|append|save/ },
  { kind: 'document', match: /read|open|cat|view|list|file/ },
];

export function toolIconKind(name: string): ToolIconKind {
  const normalized = name.trim().toLowerCase();
  return families.find((family) => family.match.test(normalized))?.kind ?? 'gear';
}

const shapes: Record<ToolIconKind, ReactElement> = {
  terminal: <><path d="m6.2 5.8 4.4 4.4-4.4 4.4" /><path d="m13.8 5.8-4.4 4.4 4.4 4.4" /></>,
  document: <><path d="M6.2 3.6h4.6l3.4 3.4v9.4H6.2z" /><path d="M10.8 3.6v3.4h3.4" /></>,
  'document-write': <><path d="M10 3.8v7.6m-2.6-2.6L10 11.4l2.6-2.6" /><path d="M4.6 13.6v1.8h10.8v-1.8" /></>,
  pencil: <><path d="m4.6 14.8.6-2.9 7.6-7.6 2.4 2.4-7.6 7.6z" /><path d="m11.6 5.6 2.4 2.4" /></>,
  search: <><circle cx="9.2" cy="9.2" r="4.4" /><path d="m12.6 12.6 3.2 3.2" /></>,
  agent: <><rect x="4.4" y="7.2" width="11.2" height="8" rx="2.6" /><path d="M10 4.2v3M7.8 11.4h.01M12.2 11.4h.01" /></>,
  globe: <><circle cx="10" cy="10" r="6.2" /><path d="M3.8 10h12.4" /><path d="M10 3.8c1.7 1.8 2.6 3.9 2.6 6.2s-.9 4.4-2.6 6.2c-1.7-1.8-2.6-3.9-2.6-6.2S8.3 5.6 10 3.8Z" /></>,
  checklist: <><path d="M4.4 6.6 6 8.2l2.6-2.8M4.4 13.6 6 15.2l2.6-2.8M11.4 7h4.6M11.4 14h4.6" /></>,
  notebook: <><rect x="5" y="3.8" width="10" height="12.4" rx="1.8" /><path d="M8 3.8v12.4" /></>,
  link: <><circle cx="6.4" cy="6.4" r="2.4" /><circle cx="13.6" cy="13.6" r="2.4" /><path d="m8.2 8.2 3.6 3.6" /></>,
  gear: <><circle cx="10" cy="10" r="2.4" /><path d="M10 3.6v2.2M10 14.2v2.2M3.6 10h2.2M14.2 10h2.2M5.5 5.5l1.6 1.6M12.9 12.9l1.6 1.6M14.5 5.5l-1.6 1.6M7.1 12.9l-1.6 1.6" /></>,
};

/** The glyph that sits in front of a tool row's name, styled like the thought icon. */
export function ToolIcon({ name }: { name: string }) {
  return <svg className="panel-tool-icon" viewBox="0 0 20 20" aria-hidden="true">{shapes[toolIconKind(name)]}</svg>;
}
