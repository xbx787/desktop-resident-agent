import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSnapshot, PetAPI, SlashUiAction } from '../shared/contracts'

const api: PetAPI = {
  getSnapshot: () => ipcRenderer.invoke('pet:get-snapshot'),
  sendMessage: (text, attachments, strategy, conversationId) => ipcRenderer.invoke('pet:send-message', text, attachments, strategy, conversationId),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  prepareDroppedFile: (filePath) => ipcRenderer.invoke('pet:prepare-dropped-file', filePath),
  preparePastedFile: (request) => ipcRenderer.invoke('pet:prepare-pasted-file', request),
  readImagePreview: (filePath) => ipcRenderer.invoke('pet:read-image-preview', filePath),
  createConversation: (title) => ipcRenderer.invoke('pet:create-conversation', title),
  selectConversation: (id) => ipcRenderer.invoke('pet:select-conversation', id),
  renameConversation: (id, title) => ipcRenderer.invoke('pet:rename-conversation', id, title),
  setConversationPinned: (id, pinned) => ipcRenderer.invoke('pet:set-conversation-pinned', id, pinned),
  archiveConversation: (id) => ipcRenderer.invoke('pet:archive-conversation', id),
  restoreConversation: (id) => ipcRenderer.invoke('pet:restore-conversation', id),
  deleteConversation: (id) => ipcRenderer.invoke('pet:delete-conversation', id),
  getContextUsage: (conversationId) => ipcRenderer.invoke('pet:get-context-usage', conversationId),
  compactConversation: (conversationId) => ipcRenderer.invoke('pet:compact-conversation', conversationId),
  listClaudeWorkflows: () => ipcRenderer.invoke('pet:list-claude-workflows'),
  onSlashUiAction: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, action: SlashUiAction): void => callback(action)
    ipcRenderer.on('pet:slash-ui', listener)
    return () => ipcRenderer.removeListener('pet:slash-ui', listener)
  },
  searchWorkspaceFiles: (query) => ipcRenderer.invoke('pet:search-workspace-files', query),
  searchConversations: (query, archived) => ipcRenderer.invoke('pet:search-conversations', query, archived),
  removeQueuedMessage: (id) => ipcRenderer.invoke('pet:remove-queued-message', id),
  steerQueuedMessage: (id) => ipcRenderer.invoke('pet:steer-queued-message', id),
  approveAction: (id, conversationId) => ipcRenderer.invoke('pet:approve-action', id, conversationId),
  rejectAction: (id, conversationId) => ipcRenderer.invoke('pet:reject-action', id, conversationId),
  answerQuestion: (id, answers, conversationId) => ipcRenderer.invoke('pet:answer-question', id, answers, conversationId),
  answerPlan: (id, approved, conversationId) => ipcRenderer.invoke('pet:answer-plan', id, approved, conversationId),
  stop: (conversationId) => ipcRenderer.invoke('pet:stop', conversationId),
  saveModelProfile: (profile) => ipcRenderer.invoke('pet:save-model-profile', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('pet:delete-model-profile', id),
  setModelProfile: (id) => ipcRenderer.invoke('pet:set-model-profile', id),
  testModelProfile: (profile) => ipcRenderer.invoke('pet:test-model-profile', profile),
  setEnableAutoTitleGeneration: (on) => ipcRenderer.invoke('pet:set-auto-title', on),
  setShowMessageTimestamps: (on) => ipcRenderer.invoke('pet:set-timestamps', on),
  setUserNames: (userName, assistantName) => ipcRenderer.invoke('pet:set-user-names', userName, assistantName),
  setAvatar: (kind, bytes) => ipcRenderer.invoke('pet:set-avatar', kind, bytes),
  readAvatar: (kind) => ipcRenderer.invoke('pet:read-avatar', kind),
  openSettings: () => ipcRenderer.invoke('pet:open-settings'),
  openOnboarding: () => ipcRenderer.invoke('pet:open-onboarding'),
  interruptTurn: (conversationId) => ipcRenderer.invoke('pet:interrupt-turn', conversationId),
  showPanel: () => ipcRenderer.invoke('pet:show-panel'),
  hidePanel: () => ipcRenderer.invoke('pet:hide-panel'),
  getPanelOpen: () => ipcRenderer.invoke('pet:get-panel-open'),
  onPanelOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:panel-open', listener)
    return () => ipcRenderer.removeListener('pet:panel-open', listener)
  },
  showContextMenu: () => ipcRenderer.invoke('pet:show-context-menu'),
  setBalanceOpen: (open) => ipcRenderer.invoke('pet:set-balance-open', open),
  onBalanceOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:balance-open', listener)
    return () => ipcRenderer.removeListener('pet:balance-open', listener)
  },
  getBalance: () => ipcRenderer.invoke('pet:get-balance'),
  openExternal: (url) => ipcRenderer.invoke('pet:open-external', url),
  setBubbleLayout: (layout, height) => ipcRenderer.invoke('pet:set-bubble-layout', layout, height),
  setBubbleExpanded: (expanded) => ipcRenderer.invoke('pet:set-bubble-expanded', expanded),
  setModelMode: (mode) => ipcRenderer.invoke('pet:set-model-mode', mode),
  setEffort: (level) => ipcRenderer.invoke('pet:set-effort', level),
  setPlanMode: (on) => ipcRenderer.invoke('pet:set-plan-mode', on),
  setAvatarState: (state) => ipcRenderer.invoke('pet:set-avatar-state', state),
  getVoiceConfig: () => ipcRenderer.invoke('pet:get-voice-config'),
  transcribeAudio: (request) => ipcRenderer.invoke('pet:transcribe-audio', request),
  voiceLog: (level, message, data) => ipcRenderer.invoke('pet:voice-log', level, message, data),
  quit: () => ipcRenderer.invoke('pet:quit'),
  beginDrag: (position) => ipcRenderer.invoke('pet:begin-drag', position),
  dragMove: (position) => ipcRenderer.invoke('pet:drag-move', position),
  endDrag: () => ipcRenderer.invoke('pet:end-drag'),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: AppSnapshot): void => callback(snapshot)
    ipcRenderer.on('pet:snapshot', listener)
    return () => ipcRenderer.removeListener('pet:snapshot', listener)
  }
}

contextBridge.exposeInMainWorld('pet', api)
