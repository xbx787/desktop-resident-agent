/** Stable seam between the conversation runtime and whichever agent kernel
 *  actually executes a turn.
 *
 *  `ModelClient` is the callback contract the runtime already speaks. Keeping
 *  the alias here makes the migration boundary explicit: Claude Code is one
 *  implementation (`ClaudeAgentClient`), DeepSeek Harness will be another
 *  (`DshAgentClient`). The UI and persistence layers never import a kernel
 *  package directly. */
import type { ModelClient } from './deepseek'

export type AgentKernel = ModelClient

export type AgentKernelKind = 'claude_code' | 'dsh'

/** The kernel a conversation record was last written with. */
export function isAgentKernelKind(value: unknown): value is AgentKernelKind {
  return value === 'claude_code' || value === 'dsh'
}
