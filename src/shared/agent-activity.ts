/** Stable work semantics shared by the agent runtime and portrait renderers.
 * Tool names are adapter details; animation packages should only depend on
 * these categories. */
export type AgentActivity =
  | 'reading'
  | 'writing'
  | 'terminal'
  | 'searching'
  | 'drawing'
  | 'delegating'
  | 'other'

function normalizedToolSubject(name: string): string {
  const lower = name.trim().toLowerCase()
  const mcp = /^mcp__.+?__(.+)$/u.exec(lower)
  return (mcp?.[1] ?? lower).replace(/[_\-\s]/gu, '')
}

function activityForSubject(subject: string): AgentActivity | undefined {
  if (/subagent|delegate|spawn|fork|teammate|agenttask/u.test(subject)) return 'delegating'
  if (/imagegen|draw|canvas|illustrat|renderimage|generateimage/u.test(subject)) return 'drawing'
  if (/websearch|searchweb|webfetch|browser|browse|internet|fetchurl|urlfetch|http/u.test(subject)) return 'searching'
  if (/bash|pwsh|powershell|shell|terminal|command|exec|execute|runprocess/u.test(subject)) return 'terminal'
  if (/write|edit|patch|replace|modify|update|append|save|createfile|delete|removefile|move/u.test(subject)) return 'writing'
  if (/read|open|view|load|cat|showfile|listdir|listfiles?|directory|workingdirectory|grep|glob|searchfiles?|sessionsearch|findbyname|findfiles?|lookup/u.test(subject)) return 'reading'
  if (/search|query|fetch/u.test(subject)) return 'searching'
  return undefined
}

/** Prefer an adapter-provided kind, then classify the concrete tool name.
 * Unknown tools stay `other`; substring matching is deliberately a fallback
 * so a future DSH tool can add an explicit kind without changing the UI. */
export function agentActivityForTool(name: string, kind = ''): AgentActivity {
  const normalizedKind = normalizedToolSubject(kind)
  const normalizedName = normalizedToolSubject(name)
  // ACP `search` covers local Grep/Glob and remote search. Let the concrete
  // title refine this one ambiguous kind while every other known kind wins.
  if (normalizedKind === 'search') return activityForSubject(normalizedName) ?? 'searching'
  return activityForSubject(normalizedKind)
    ?? activityForSubject(normalizedName)
    ?? 'other'
}
