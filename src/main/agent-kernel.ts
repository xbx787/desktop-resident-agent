/** Stable seam between the conversation runtime and the agent kernel.
 *
 *  `ModelClient` is the callback contract the runtime already speaks. The only
 *  current implementation is DSH (`DshAcpAgentClient`); the UI and persistence
 *  layers never import a kernel package directly. */
import type { ModelClient } from './deepseek'

export type AgentKernel = ModelClient
