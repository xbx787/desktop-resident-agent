export type AvatarState = 'idle' | 'thinking' | 'listening' | 'speaking' | 'acting' | 'success' | 'error'
export type ModelMode = 'demo' | 'live' | 'claude_code'
export type BubbleLayout = 'empty' | 'composer' | 'composer_attachments' | 'composer_models' | 'full'

export type TaskStatus =
  | 'idle'
  | 'planning'
  | 'awaiting_approval'
  | 'executing'
  | 'verifying'
  | 'done'
  | 'failed'
  | 'cancelled'

export interface TimelineEntry {
  id: string
  time: string
  kind: 'user' | 'assistant' | 'system' | 'tool'
  text: string
}

export interface ProposedAction {
  id: string
  tool: 'write_test_note' | 'claude_tool'
  description: string
  target: string
  content: string
  risk: 'read' | 'write' | 'execute'
}

export interface UserAttachment {
  name: string
  content: string
}

export interface BalanceLine {
  currency: 'CNY' | 'USD'
  total: string
  granted: string
  toppedUp: string
}

export interface BalanceSnapshot {
  available: boolean
  balances: BalanceLine[]
  checkedAt: string
}

export interface AppSnapshot {
  mode: ModelMode
  avatarState: AvatarState
  taskStatus: TaskStatus
  timeline: TimelineEntry[]
  proposal?: ProposedAction
  currentTask?: string
  modelReady: boolean
  claudeCodeReady: boolean
}

export interface VoiceConfig {
  siliconFlowApiKey?: string
  siliconFlowModel?: string
  siliconFlowBaseUrl?: string
}

export interface PetAPI {
  getSnapshot(): Promise<AppSnapshot>
  sendMessage(text: string, attachments?: UserAttachment[]): Promise<void>
  approveAction(id: string): Promise<void>
  rejectAction(id: string): Promise<void>
  stop(): Promise<void>
  showPanel(): Promise<void>
  hidePanel(): Promise<void>
  getPanelOpen(): Promise<boolean>
  onPanelOpen(callback: (open: boolean) => void): () => void
  setMenuOpen(open: boolean): Promise<void>
  setBalanceOpen(open: boolean): Promise<void>
  onBalanceOpen(callback: (open: boolean) => void): () => void
  getBalance(): Promise<BalanceSnapshot>
  setBubbleLayout(layout: BubbleLayout): Promise<void>
  setModelMode(mode: ModelMode): Promise<void>
  setAvatarState(state: AvatarState): Promise<void>
  getVoiceConfig(): Promise<VoiceConfig>
  transcribeAudio(request: { bytes: number[]; mimeType: string; apiKey: string; model?: string; baseUrl?: string }): Promise<{ text: string }>
  quit(): Promise<void>
  beginDrag(position: { x: number; y: number }): Promise<void>
  dragMove(position: { x: number; y: number }): Promise<void>
  endDrag(): Promise<void>
  onSnapshot(callback: (snapshot: AppSnapshot) => void): () => void
}

declare global {
  interface Window {
    pet: PetAPI
  }
}
