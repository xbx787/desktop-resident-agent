import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { AgentRuntime } from './agent-runtime'
import { ClaudeAgentClient } from './claude-agent'
import { findClaudeExecutable } from './claude-code'
import { DeepSeekClient } from './deepseek'
import { fetchDeepSeekBalance } from './deepseek-balance'
import { transcribeAudio } from './asr-server'
import { voiceLog, voiceLogError } from './voice-log'
import { NoteStore } from './note-store'
import { getEnabledDeepSeekKey } from './model-config'
import type { BubbleLayout } from '../shared/contracts'

const projectRoot = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..')
const userDataDirectory = path.join(projectRoot, 'data', 'electron')
mkdirSync(userDataDirectory, { recursive: true })
app.setPath('userData', userDataDirectory)

let avatarWindow: BrowserWindow | undefined
let panelOpen = false
let menuOpen = false
let balanceOpen = false
let bubbleLayout: BubbleLayout = 'empty'
let dragOrigin: { cursor: Electron.Point; bounds: Electron.Rectangle } | undefined
let shapeShrinkTimer: NodeJS.Timeout | undefined
let rendererAvatarState: import('../shared/contracts').AvatarState | undefined

const stageSize = { width: 376, height: 560 }
const avatarRegion = { x: 208, y: 374, width: 160, height: 180 }
const menuRegion = { x: 10, y: 490, width: 174, height: 50 }
const balanceRegion = { x: 10, y: 208, width: 276, height: 167 }

function bubbleRegion(layout: BubbleLayout): Electron.Rectangle {
  switch (layout) {
    case 'empty': return { x: 256, y: 312, width: 64, height: 63 }
    case 'composer': return { x: 34, y: 220, width: 332, height: 155 }
    case 'composer_attachments': return { x: 34, y: 194, width: 332, height: 181 }
    case 'composer_models': return { x: 34, y: 130, width: 332, height: 245 }
    case 'full': return { x: 10, y: 10, width: 356, height: 365 }
  }
}

function applyPointerShape(): void {
  const win = avatarWindow
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  const regions = [avatarRegion]
  if (panelOpen) regions.push(bubbleRegion(bubbleLayout))
  if (menuOpen) regions.push(menuRegion)
  if (balanceOpen) regions.push(balanceRegion)
  win.setShape(regions)
}

const apiKey = getEnabledDeepSeekKey(process.env)
const claudeKey = process.env.DEEPSEEK_API_KEY?.trim()
const claudeExecutable = findClaudeExecutable(process.env)
function publishSnapshot(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return
  const snapshot = runtime.getSnapshot()
  if (rendererAvatarState) snapshot.avatarState = rendererAvatarState
  avatarWindow.webContents.send('pet:snapshot', snapshot)
}

const runtime = new AgentRuntime(
  new NoteStore(projectRoot),
  apiKey ? new DeepSeekClient(apiKey) : undefined,
  () => publishSnapshot(),
  claudeKey && claudeExecutable ? new ClaudeAgentClient(claudeExecutable, claudeKey, projectRoot) : undefined
)

function rendererUrl(): string | undefined {
  const base = process.env.ELECTRON_RENDERER_URL
  return base ? `${base}/avatar.html` : undefined
}

function loadPage(win: BrowserWindow): void {
  const url = rendererUrl()
  if (url) void win.loadURL(url)
  else void win.loadFile(path.join(__dirname, '../renderer/avatar.html'))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function createAvatarWindow(): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea
  const { width, height } = stageSize
  const x = work.x + work.width - width - 24
  const y = work.y + work.height - height - 24
  const win = new BrowserWindow({
    x,
    y,
    width,
    height,
    minWidth: stageSize.width,
    minHeight: stageSize.height,
    maxWidth: stageSize.width,
    maxHeight: stageSize.height,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    resizable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.platform === 'win32') win.setShape([avatarRegion])
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    avatarWindow = undefined
    app.quit()
  })
  loadPage(win)
  return win
}

function showPanel(): void {
  if (balanceOpen) {
    balanceOpen = false
    avatarWindow?.webContents.send('pet:balance-open', false)
  }
  if (!panelOpen) {
    panelOpen = true
    applyPointerShape()
    avatarWindow?.webContents.send('pet:panel-open', true)
  }
  avatarWindow?.focus()
}

function hidePanel(): void {
  if (!panelOpen) return
  panelOpen = false
  avatarWindow?.webContents.send('pet:panel-open', false)
  if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
  shapeShrinkTimer = undefined
  applyPointerShape()
}

function isScreenPoint(value: unknown): value is Electron.Point {
  return Boolean(value && typeof value === 'object' && Number.isFinite((value as Electron.Point).x) && Number.isFinite((value as Electron.Point).y))
}

function registerIpc(): void {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === avatarWindow?.webContents.id
  ipcMain.handle('pet:get-snapshot', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    return runtime.getSnapshot()
  })
  ipcMain.handle('pet:send-message', (event, text: unknown, attachments: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof text !== 'string') throw new Error('消息必须是文本。')
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.some((item) => !item || typeof item !== 'object' || typeof item.name !== 'string' || typeof item.content !== 'string'))) {
      throw new Error('附件数据无效。')
    }
    return runtime.sendMessage(text, (attachments ?? []) as Array<{ name: string; content: string }>)
  })
  ipcMain.handle('pet:approve-action', (event, id: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('操作编号无效。')
    return runtime.approveAction(id)
  })
  ipcMain.handle('pet:reject-action', (event, id: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('操作编号无效。')
    runtime.rejectAction(id)
  })
  ipcMain.handle('pet:stop', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    runtime.stop()
  })
  ipcMain.handle('pet:show-panel', (event) => { if (trusted(event)) showPanel() })
  ipcMain.handle('pet:hide-panel', (event) => { if (trusted(event)) hidePanel() })
  ipcMain.handle('pet:get-panel-open', (event) => { if (!trusted(event)) throw new Error('无效的界面请求。'); return panelOpen })
  ipcMain.handle('pet:set-menu-open', (event, open: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (typeof open !== 'boolean') throw new Error('菜单状态无效。')
    if (menuOpen === open) return
    menuOpen = open
    applyPointerShape()
  })
  ipcMain.handle('pet:set-balance-open', (event, open: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof open !== 'boolean') throw new Error('余额卡片状态无效。')
    if (open && panelOpen) hidePanel()
    balanceOpen = open
    applyPointerShape()
    avatarWindow?.webContents.send('pet:balance-open', open)
  })
  ipcMain.handle('pet:get-balance', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!claudeKey) throw new Error('本机尚未配置 DeepSeek API Key。')
    return fetchDeepSeekBalance(claudeKey)
  })
  ipcMain.handle('pet:set-bubble-layout', (event, layout: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (layout !== 'empty' && layout !== 'composer' && layout !== 'composer_attachments' && layout !== 'composer_models' && layout !== 'full') throw new Error('气泡布局无效。')
    if (bubbleLayout === layout) return
    const previous = bubbleRegion(bubbleLayout)
    bubbleLayout = layout
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    const next = bubbleRegion(layout)
    if (panelOpen && next.width * next.height < previous.width * previous.height) {
      shapeShrinkTimer = setTimeout(() => {
        shapeShrinkTimer = undefined
        applyPointerShape()
      }, 240)
    } else {
      applyPointerShape()
    }
  })
  ipcMain.handle('pet:set-model-mode', (event, mode: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (mode !== 'demo' && mode !== 'live' && mode !== 'claude_code') throw new Error('模型选项无效。')
    runtime.setModelMode(mode)
  })
  ipcMain.handle('pet:set-avatar-state', (event, state: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (state !== 'idle' && state !== 'thinking' && state !== 'listening' && state !== 'speaking' && state !== 'acting' && state !== 'success' && state !== 'error') {
      throw new Error('角色状态无效。')
    }
    const taskStatus = runtime.getSnapshot().taskStatus
    if (state === 'idle' && ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(taskStatus)) {
      throw new Error('任务进行中时不能将角色状态设为待机。')
    }
    rendererAvatarState = state === 'idle' ? undefined : state
    publishSnapshot()
  })
  ipcMain.handle('pet:get-voice-config', (event) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return {}
    return {
      siliconFlowApiKey: process.env.SILICONFLOW_API_KEY,
      siliconFlowModel: process.env.SILICONFLOW_MODEL,
      siliconFlowBaseUrl: process.env.SILICONFLOW_BASE_URL,
    }
  })
  ipcMain.handle('pet:transcribe-audio', async (event, request: unknown) => {
    voiceLog('[ipc] transcribe-audio called', { hasRequest: !!request, senderId: event.sender.id })
    if (event.sender.id !== avatarWindow?.webContents.id) throw new Error('无效的界面请求。')
    if (!request || typeof request !== 'object') throw new Error('转写请求无效。')
    const req = request as { bytes?: number[]; mimeType?: string; apiKey?: string; model?: string; baseUrl?: string }
    voiceLog('[ipc] request', { bytesLen: req.bytes?.length, mimeType: req.mimeType, hasKey: !!req.apiKey, model: req.model })
    if (!Array.isArray(req.bytes) || req.bytes.length === 0) throw new Error('音频数据无效。')
    if (!req.apiKey) throw new Error('未配置 SiliconFlow API Key。')
    try {
      const result = await transcribeAudio({
        bytes: req.bytes,
        mimeType: req.mimeType ?? 'audio/webm',
        apiKey: req.apiKey,
        model: req.model,
        baseUrl: req.baseUrl,
      })
      voiceLog('[ipc] transcribe success', result)
      return result
    } catch (error) {
      voiceLogError('[ipc] transcribe failed', error)
      throw error
    }
  })
  ipcMain.handle('pet:voice-log', (event, level: unknown, message: unknown, data: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (level === 'error') voiceLogError(String(message ?? ''), data)
    else voiceLog(String(message ?? ''), data)
  })
  ipcMain.handle('pet:quit', (event) => { if (trusted(event)) app.quit() })
  ipcMain.handle('pet:begin-drag', (event, cursor: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id || !avatarWindow || !isScreenPoint(cursor)) return
    dragOrigin = { cursor, bounds: avatarWindow.getBounds() }
  })
  ipcMain.handle('pet:drag-move', (event, current: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id || !avatarWindow || !dragOrigin || !isScreenPoint(current)) return
    const x = Math.round(dragOrigin.bounds.x + current.x - dragOrigin.cursor.x)
    const y = Math.round(dragOrigin.bounds.y + current.y - dragOrigin.cursor.y)
    avatarWindow.setBounds({
      x,
      y,
      width: stageSize.width,
      height: stageSize.height
    })
  })
  ipcMain.handle('pet:end-drag', (event) => {
    if (trusted(event)) dragOrigin = undefined
  })
}

app.whenReady().then(async () => {
  registerIpc()
  avatarWindow = createAvatarWindow()

  // 自检模式：node/electron --self-test-asr 用测试音频调用 transcribeAudio
  if (process.argv.includes('--self-test-asr')) {
    voiceLog('[selftest] start', { args: process.argv })
    try {
      const fs = await import('node:fs')
      const testAudio = path.join(projectRoot, 'scripts', 'test-zh.wav')
      voiceLog('[selftest] audio path', { testAudio, exists: fs.existsSync(testAudio) })
      if (fs.existsSync(testAudio)) {
        const buffer = fs.readFileSync(testAudio)
        const bytes = Array.from(buffer)
        const apiKey = process.env.SILICONFLOW_API_KEY
        voiceLog('[selftest] config', { bytesLen: bytes.length, hasKey: !!apiKey })
        if (apiKey) {
          const result = await transcribeAudio({
            bytes,
            mimeType: 'audio/wav',
            apiKey,
            model: 'FunAudioLLM/SenseVoiceSmall',
          })
          voiceLog('[selftest] result', result)
        } else {
          voiceLogError('[selftest] no SILICONFLOW_API_KEY', new Error('missing key'))
        }
      } else {
        voiceLogError('[selftest] test audio not found', { testAudio })
      }
    } catch (error) {
      voiceLogError('[selftest] failed', error)
    } finally {
      voiceLog('[selftest] done, quitting', undefined)
      setTimeout(() => app.quit(), 500)
    }
  }
})

app.on('before-quit', () => {
  runtime.stop()
})

app.on('window-all-closed', () => app.quit())
