import { contextBridge, ipcRenderer } from 'electron'
import type { AppSnapshot, PetAPI } from '../shared/contracts'

const api: PetAPI = {
  getSnapshot: () => ipcRenderer.invoke('pet:get-snapshot'),
  sendMessage: (text, attachments) => ipcRenderer.invoke('pet:send-message', text, attachments),
  approveAction: (id) => ipcRenderer.invoke('pet:approve-action', id),
  rejectAction: (id) => ipcRenderer.invoke('pet:reject-action', id),
  stop: () => ipcRenderer.invoke('pet:stop'),
  showPanel: () => ipcRenderer.invoke('pet:show-panel'),
  hidePanel: () => ipcRenderer.invoke('pet:hide-panel'),
  getPanelOpen: () => ipcRenderer.invoke('pet:get-panel-open'),
  onPanelOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:panel-open', listener)
    return () => ipcRenderer.removeListener('pet:panel-open', listener)
  },
  setMenuOpen: (open) => ipcRenderer.invoke('pet:set-menu-open', open),
  setBalanceOpen: (open) => ipcRenderer.invoke('pet:set-balance-open', open),
  onBalanceOpen: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on('pet:balance-open', listener)
    return () => ipcRenderer.removeListener('pet:balance-open', listener)
  },
  getBalance: () => ipcRenderer.invoke('pet:get-balance'),
  setBubbleLayout: (layout) => ipcRenderer.invoke('pet:set-bubble-layout', layout),
  setModelMode: (mode) => ipcRenderer.invoke('pet:set-model-mode', mode),
  setAvatarState: (state) => ipcRenderer.invoke('pet:set-avatar-state', state),
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
