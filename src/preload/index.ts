import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AppSnapshot, PanelPlacement, PetAPI, SideChatSnapshot, SlashUiAction, VoiceConfig } from '../shared/contracts'

const api: PetAPI = {
  getSnapshot: () => ipcRenderer.invoke('pet:get-snapshot'),
  getSideChat: () => ipcRenderer.invoke('pet:side:get'),
  openSideChat: () => ipcRenderer.invoke('pet:side:open'),
  setSideChatExpanded: (sessionId, expanded) => ipcRenderer.invoke('pet:side:set-expanded', sessionId, expanded),
  discardSideChat: (sessionId) => ipcRenderer.invoke('pet:side:discard', sessionId),
  sendSideChatMessage: (sessionId, text, attachments, strategy) => ipcRenderer.invoke('pet:side:send', sessionId, text, attachments, strategy),
  stopSideChat: (sessionId) => ipcRenderer.invoke('pet:side:stop', sessionId),
  interruptSideChat: (sessionId) => ipcRenderer.invoke('pet:side:interrupt', sessionId),
  removeSideQueuedMessage: (sessionId, messageId) => ipcRenderer.invoke('pet:side:remove-queued', sessionId, messageId),
  steerSideQueuedMessage: (sessionId, messageId) => ipcRenderer.invoke('pet:side:steer-queued', sessionId, messageId),
  approveSideChatAction: (sessionId, id) => ipcRenderer.invoke('pet:side:approve-action', sessionId, id),
  rejectSideChatAction: (sessionId, id) => ipcRenderer.invoke('pet:side:reject-action', sessionId, id),
  answerSideChatQuestion: (sessionId, id, answers) => ipcRenderer.invoke('pet:side:answer-question', sessionId, id, answers),
  answerSideChatPlan: (sessionId, id, approved) => ipcRenderer.invoke('pet:side:answer-plan', sessionId, id, approved),
  getSideChatContextUsage: (sessionId) => ipcRenderer.invoke('pet:side:get-context-usage', sessionId),
  compactSideChat: (sessionId) => ipcRenderer.invoke('pet:side:compact', sessionId),
  setSideChatModelMode: (sessionId, mode) => ipcRenderer.invoke('pet:side:set-model-mode', sessionId, mode),
  setSideChatPlanMode: (sessionId, on) => ipcRenderer.invoke('pet:side:set-plan-mode', sessionId, on),
  onSideChatSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: SideChatSnapshot): void => callback(snapshot)
    ipcRenderer.on('pet:side-snapshot', listener)
    return () => ipcRenderer.removeListener('pet:side-snapshot', listener)
  },
  sendMessage: (text, attachments, strategy, conversationId) => ipcRenderer.invoke('pet:send-message', text, attachments, strategy, conversationId),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  prepareDroppedFile: (filePath) => ipcRenderer.invoke('pet:prepare-dropped-file', filePath),
  preparePastedFile: (request) => ipcRenderer.invoke('pet:prepare-pasted-file', request),
  readImagePreview: (filePath) => ipcRenderer.invoke('pet:read-image-preview', filePath),
  createConversation: (title) => ipcRenderer.invoke('pet:create-conversation', title),
  selectConversation: (id) => ipcRenderer.invoke('pet:select-conversation', id),
  renameConversation: (id, title) => ipcRenderer.invoke('pet:rename-conversation', id, title),
  setConversationPinned: (id, pinned) => ipcRenderer.invoke('pet:set-conversation-pinned', id, pinned),
  setConversationTabOrder: (ids) => ipcRenderer.invoke('pet:set-tab-order', ids),
  archiveConversation: (id) => ipcRenderer.invoke('pet:archive-conversation', id),
  restoreConversation: (id) => ipcRenderer.invoke('pet:restore-conversation', id),
  deleteConversation: (id) => ipcRenderer.invoke('pet:delete-conversation', id),
  batchManageConversations: (action, ids) => ipcRenderer.invoke('pet:batch-manage-conversations', action, ids),
  deleteTurn: (conversationId, userEntryId) => ipcRenderer.invoke('pet:delete-turn', conversationId, userEntryId),
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
  listLibraries: () => ipcRenderer.invoke('pet:libraries:installed'),
  removeQueuedMessage: (id) => ipcRenderer.invoke('pet:remove-queued-message', id),
  steerQueuedMessage: (id) => ipcRenderer.invoke('pet:steer-queued-message', id),
  approveAction: (id, conversationId) => ipcRenderer.invoke('pet:approve-action', id, conversationId),
  rejectAction: (id, conversationId) => ipcRenderer.invoke('pet:reject-action', id, conversationId),
  answerQuestion: (id, answers, conversationId) => ipcRenderer.invoke('pet:answer-question', id, answers, conversationId),
  answerPlan: (id, approved, conversationId) => ipcRenderer.invoke('pet:answer-plan', id, approved, conversationId),
  answerPermission: (id, allow, conversationId) => ipcRenderer.invoke('pet:answer-permission', id, allow, conversationId),
  saveDraft: (conversationId, text) => ipcRenderer.invoke('pet:save-draft', conversationId, text),
  getDraft: (conversationId) => ipcRenderer.invoke('pet:get-draft', conversationId),
  clearGoal: (conversationId) => ipcRenderer.invoke('pet:clear-goal', conversationId),
  stop: (conversationId) => ipcRenderer.invoke('pet:stop', conversationId),
  saveModelProfile: (profile) => ipcRenderer.invoke('pet:save-model-profile', profile),
  deleteModelProfile: (id) => ipcRenderer.invoke('pet:delete-model-profile', id),
  setModelProfile: (id) => ipcRenderer.invoke('pet:set-model-profile', id),
  testModelProfile: (profile) => ipcRenderer.invoke('pet:test-model-profile', profile),
  exportConversation: (conversationId) => ipcRenderer.invoke('pet:export-conversation', conversationId),
  importConversation: () => ipcRenderer.invoke('pet:import-conversation'),
  setEnableAutoTitleGeneration: (on) => ipcRenderer.invoke('pet:set-auto-title', on),
  setShowMessageTimestamps: (on) => ipcRenderer.invoke('pet:set-timestamps', on),
  setUserNames: (userName, assistantName) => ipcRenderer.invoke('pet:set-user-names', userName, assistantName),
  setAvatar: (kind, bytes) => ipcRenderer.invoke('pet:set-avatar', kind, bytes),
  readAvatar: (kind) => ipcRenderer.invoke('pet:read-avatar', kind),
  openSettings: () => ipcRenderer.invoke('pet:open-settings'),
  openOnboarding: () => ipcRenderer.invoke('pet:open-onboarding'),
  interruptTurn: (conversationId) => ipcRenderer.invoke('pet:interrupt-turn', conversationId),
  backgroundTask: (toolUseId, conversationId) => ipcRenderer.invoke('pet:background-task', toolUseId, conversationId),
  stopTask: (taskId, conversationId) => ipcRenderer.invoke('pet:stop-task', taskId, conversationId),
  messageSubagent: (toolUseId, text, conversationId) => ipcRenderer.invoke('pet:message-subagent', toolUseId, text, conversationId),
  resumeQueue: (conversationId) => ipcRenderer.invoke('pet:resume-queue', conversationId),
  showPanel: () => ipcRenderer.invoke('pet:show-panel'),
  hidePanel: () => ipcRenderer.invoke('pet:hide-panel'),
  getPanelOpen: () => ipcRenderer.invoke('pet:get-panel-open'),
  onPanelOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:panel-open', listener)
    return () => ipcRenderer.removeListener('pet:panel-open', listener)
  },
  getPanelDirection: () => ipcRenderer.invoke('pet:get-panel-direction'),
  getPanelPlacement: () => ipcRenderer.invoke('pet:get-panel-placement'),
  onPanelPlacement: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, placement: PanelPlacement): void => callback(placement)
    ipcRenderer.on('pet:panel-placement', listener)
    return () => ipcRenderer.removeListener('pet:panel-placement', listener)
  },
  onPanelTailX: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, x: number): void => callback(x)
    ipcRenderer.on('pet:panel-tail-x', listener)
    return () => ipcRenderer.removeListener('pet:panel-tail-x', listener)
  },
  onInputActivity: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, activity: import('../shared/input-activity').InputActivity): void => callback(activity)
    ipcRenderer.on('pet:input-activity', listener)
    return () => ipcRenderer.removeListener('pet:input-activity', listener)
  },
  onPanelDirection: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, direction: 'up' | 'down'): void => callback(direction)
    ipcRenderer.on('pet:panel-direction', listener)
    return () => ipcRenderer.removeListener('pet:panel-direction', listener)
  },
  showContextMenu: () => ipcRenderer.invoke('pet:show-context-menu'),
  showTextMenu: (payload) => ipcRenderer.invoke('pet:show-text-menu', payload),
  setBalanceOpen: (open) => ipcRenderer.invoke('pet:set-balance-open', open),
  toggleBalance: () => ipcRenderer.invoke('pet:toggle-balance'),
  onBalanceOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:balance-open', listener)
    return () => ipcRenderer.removeListener('pet:balance-open', listener)
  },
  getBalance: () => ipcRenderer.invoke('pet:get-balance'),
  openExternal: (url) => ipcRenderer.invoke('pet:open-external', url),
  openPath: (target) => ipcRenderer.invoke('pet:open-path', target),
  setBubbleLayout: (layout, height) => ipcRenderer.invoke('pet:set-bubble-layout', layout, height),
  setBubbleExpanded: (expanded) => ipcRenderer.invoke('pet:set-bubble-expanded', expanded),
  setPanelSize: (width, height) => ipcRenderer.invoke('pet:set-panel-size', width, height),
  resizeGhost: (pos) => ipcRenderer.send('pet:resize-ghost', pos),
  onApprovalRequest: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, request: { id: string; title: string; detail?: string }): void => callback(request)
    ipcRenderer.on('pet:approval-request', listener)
    return () => ipcRenderer.removeListener('pet:approval-request', listener)
  },
  answerApproval: (id, approved) => ipcRenderer.send('pet:approval-result', id, approved),
  onFarewell: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('pet:avatar:farewell', listener)
    return () => ipcRenderer.removeListener('pet:avatar:farewell', listener)
  },
  setAvatarBox: (box) => ipcRenderer.invoke('pet:set-avatar-box', box),
  setModelMode: (mode) => ipcRenderer.invoke('pet:set-model-mode', mode),
  setEffort: (level) => ipcRenderer.invoke('pet:set-effort', level),
  setWebSearchEnabled: (on) => ipcRenderer.invoke('pet:set-web-search', on),
  setAutoCompactPercent: (percent) => ipcRenderer.invoke('pet:set-auto-compact-percent', percent),
  setPlanMode: (on) => ipcRenderer.invoke('pet:set-plan-mode', on),
  setApprovalMode: (mode, conversationId) => ipcRenderer.invoke('pet:set-approval-mode', mode, conversationId),
  setAvatarState: (state) => ipcRenderer.invoke('pet:set-avatar-state', state),
  getVoiceConfig: () => ipcRenderer.invoke('pet:get-voice-config'),
  transcribeAudio: (request) => ipcRenderer.invoke('pet:transcribe-audio', request),
  synthesizeSpeech: (request) => ipcRenderer.invoke('pet:voice:synthesize', request),
  onVoiceConfigChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, config: VoiceConfig): void => callback(config)
    ipcRenderer.on('pet:voice-config-changed', listener)
    return () => ipcRenderer.removeListener('pet:voice-config-changed', listener)
  },
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

// 界面字号档：主进程在每个窗口加载完成时灌一次，设置窗口改档时广播。
// CSS 只认 <html data-ui-size>，所以这里直接写 DOM，不经过渲染器。
ipcRenderer.on('pet:ui-size', (_event, size: unknown) => {
  document.documentElement.dataset.uiSize = size === 'medium' || size === 'large' ? size : 'small'
})

contextBridge.exposeInMainWorld('pet', api)
