import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
import { mkdirSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { AgentRuntime } from './agent-runtime'
import { SideChatController, activeSideChatParentId } from './side-chat'
import { isAskAnswers } from './ask-questions'
import { ConversationController } from './conversation-controller'
import { MemoryService, type MemoryProvider } from './memory-service'
import { GrowthExperiments } from './growth-experiments'
import { ConversationStore, isModelProfile, MAX_BATCH_CONVERSATIONS } from './conversation-store'
import { electronSecretCodec, publicSettings, publicSnapshot, SecretProtectionUnavailableError } from './secret-storage'
import { ClaudeAgentClient } from './claude-agent'
import { linkClaudeUserResources } from './claude-resource-links'
import { CLAUDE_BASE_URL, DEFAULT_CLAUDE_MODEL, findClaudeExecutable, probeAnthropicEndpoint } from './claude-code'
import { seedClaudeMemory } from './claude-memory'
import { computeStageBounds, STAGE_HEIGHT, STAGE_WIDTH } from './stage-bounds'
import { deepSeekBaseUrl, deepSeekModel, deepSeekProfile, ONBOARDING_PAGES, readOnboardingMarker, shouldOfferOnboarding, writeOnboardingMarker, type OnboardingPage } from './onboarding'
import { normalizeApiKey } from '../shared/onboarding'
import { DeepSeekClient } from './deepseek'
import { fetchDeepSeekBalance } from './deepseek-balance'
import { transcribeAudio } from './asr-server'
import { voiceLog, voiceLogError } from './voice-log'
import { NoteStore } from './note-store'
import { createSnapshotScheduler } from './snapshot-scheduler'
import { getDeepSeekBalanceKey, getEnabledDeepSeekKey } from './model-config'
import { loadWindowsMcpConfig } from './mcp-config'
import { generateConversationTitle } from './title-generation'
import { APP_SLASH_COMMANDS, listClaudeWorkflows, parseAppSlashCommand } from './claude-workflows'
import { attachmentPreviewPath, prepareDroppedFile, readImagePreview, searchWorkspaceFiles, stagePastedAttachment, validAttachmentList, verifyDroppedFilePath } from './local-context'
import { findSourceProjectRoot, resolveAgentWorkspace } from './workspace-root'
import { isEffortLevel } from '../shared/effort'
import type { BubbleLayout, ClaudeWorkflowOption, ConversationSettings, UserAttachment } from '../shared/contracts'

const projectRoot = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..')
const dataProjectRoot = findSourceProjectRoot(projectRoot) ?? projectRoot
const dataRoot = path.join(dataProjectRoot, 'data')
const userHome = homedir()
const agentWorkspace = resolveAgentWorkspace(projectRoot, app.isPackaged, process.env, userHome)
const userDataDirectory = path.join(dataRoot, 'electron')
mkdirSync(userDataDirectory, { recursive: true })
mkdirSync(path.join(dataRoot, 'claude'), { recursive: true })
// A fresh install ships with an editable personal-settings file for the
// engine; existing files are the user's and never touched (see claude-memory).
seedClaudeMemory(path.join(dataRoot, 'claude'))
app.setPath('userData', userDataDirectory)
if (process.platform === 'win32') app.setAppUserModelId('local.desktop.resident.agent')

let avatarWindow: BrowserWindow | undefined
let balanceWindow: BrowserWindow | undefined
let settingsWindow: BrowserWindow | undefined
let onboardingWindow: BrowserWindow | undefined
let balanceWindowReady = false
let tray: Tray | undefined
let contextMenu: Menu | undefined
let panelOpen = false
let balanceOpen = false
let bubbleLayout: BubbleLayout = 'empty'
let compactBubbleHeight: number | undefined
let bubbleExpanded = false
let dragOrigin: { cursor: Electron.Point; bounds: Electron.Rectangle } | undefined
let shapeShrinkTimer: NodeJS.Timeout | undefined
let rendererAvatarState: import('../shared/contracts').AvatarState | undefined

// Keep the avatar's window origin and width stable while its cards open/close.
// The unused area stays transparent and outside the shaped hit regions.
const stageSize = { width: STAGE_WIDTH, height: STAGE_HEIGHT }

function avatarRegion(size: { width: number; height: number }): Electron.Rectangle {
  return { x: size.width - 168, y: size.height - 186, width: 160, height: 180 }
}

function bubbleRegion(layout: BubbleLayout, size: { width: number; height: number }, compactHeight = compactBubbleHeight): Electron.Rectangle {
  if (bubbleExpanded) return { x: 10, y: 0, width: size.width - 20, height: size.height - 185 }
  switch (layout) {
    case 'empty': return { x: size.width - 120, y: size.height - 248, width: 64, height: 63 }
    case 'composer':
    case 'composer_attachments': {
      const height = compactHeight ?? (layout === 'composer' ? 206 : 232)
      return { x: size.width - 342, y: size.height - 192 - height, width: 332, height: height + 7 }
    }
    case 'composer_models': return { x: size.width - 342, y: size.height - 430, width: 332, height: 245 }
    case 'full': return { x: size.width - 366, y: size.height - 550, width: 356, height: 365 }
  }
}

function applyPointerShape(): void {
  const win = avatarWindow
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  const size = win.getBounds()
  const regions = [avatarRegion(size)]
  if (panelOpen) regions.push(bubbleRegion(bubbleLayout, size))
  win.setShape(regions)
}

function syncBalancePosition(): void {
  const avatar = avatarWindow
  const balance = balanceWindow
  if (!avatar || avatar.isDestroyed() || !balance || balance.isDestroyed()) return
  const bounds = avatar.getBounds()
  // Match the former in-window card: 176 px from the right and 16 px from the bottom.
  const x = bounds.x + bounds.width - 452
  const y = bounds.y + bounds.height - 176
  const current = balance.getBounds()
  if (current.x !== x || current.y !== y) balance.setPosition(x, y, false)
}

function syncStageBounds(): void {
  const win = avatarWindow
  if (!win || win.isDestroyed()) return
  const previous = win.getBounds()
  const bottom = previous.y + previous.height
  const work = screen.getDisplayNearestPoint({ x: previous.x + previous.width - 88, y: bottom - 96 }).workArea
  const next = computeStageBounds(previous, work, bubbleExpanded)
  if (previous.x === next.x && previous.y === next.y && previous.width === next.width && previous.height === next.height) return
  if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
  shapeShrinkTimer = undefined
  win.setBounds(next, false)
  syncBalancePosition()
  applyPointerShape()
}

function setBubbleExpanded(expanded: boolean): void {
  if (bubbleExpanded === expanded) return
  bubbleExpanded = expanded
  syncStageBounds()
}

const apiKey = getEnabledDeepSeekKey(process.env)
const claudeKey = process.env.DEEPSEEK_API_KEY?.trim()
const claudeExecutable = findClaudeExecutable(process.env)
const windowsMcpServers = loadWindowsMcpConfig(path.join(userHome, '.claude.json'))
let controller: ConversationController | undefined
const memory = new MemoryService(dataRoot, { onError: (error) => console.warn(error.message) })

async function backgroundProvider(): Promise<MemoryProvider | null> {
  const settings = (await activeController().getLibraryState()).settings
  const profile = settings.modelProfiles.find((item) => item.id === settings.activeModelProfileId)
  if (profile?.apiKey) return { baseUrl: profile.baseUrl, apiKey: profile.apiKey, model: profile.model, smallModel: profile.smallModel }
  const key = claudeKey || apiKey
  return key ? { baseUrl: CLAUDE_BASE_URL, apiKey: key, model: DEFAULT_CLAUDE_MODEL, smallModel: 'deepseek-flash' } : null
}

const growth = new GrowthExperiments({
  projectRoot: dataProjectRoot, dataRoot, claudeExecutable,
  provider: backgroundProvider
})
/** Every Nth publish re-sends the whole history, so a renderer that somehow
 *  missed a delta cannot stay desynced; between those only changed entries
 *  travel (see AgentRuntime.takeTimelineDelta). */
const FULL_TIMELINE_EVERY = 64
let publishesSinceFullTimeline = FULL_TIMELINE_EVERY
let lastPublishedSideParent: string | null | undefined

function snapshotWithSideStatuses() {
  const snapshot = publicSnapshot(activeController().getSnapshot())
  snapshot.conversationLibrary.conversations = sideChat.withSideStatuses(snapshot.conversationLibrary.conversations)
  return snapshot
}

function flushSnapshot(): void {
  if (!avatarWindow || avatarWindow.isDestroyed()) return
  if (!controller) return
  const snapshot = snapshotWithSideStatuses()
  if (rendererAvatarState) snapshot.avatarState = rendererAvatarState
  // The delta belongs to the displayed conversation's runtime; a cold
  // conversation (no runtime) is a full send by construction.
  const runtime = controller.displayedRuntime()
  const delta = runtime?.takeTimelineDelta()
  const full = !delta || delta.reset || publishesSinceFullTimeline <= 0
  if (!full) {
    snapshot.timeline = delta!.entries
    snapshot.timelinePartial = true
  }
  publishesSinceFullTimeline = full ? FULL_TIMELINE_EVERY : publishesSinceFullTimeline - 1
  avatarWindow.webContents.send('pet:snapshot', snapshot)
  // A tab switch changes the child that belongs on screen. Send its full
  // snapshot after the main one so a renderer with stale tab state can still
  // recover even if side and main events were otherwise reordered.
  const parentId = activeSideChatParentId(controller.displayedConversationId(), snapshot.conversationLibrary)
  if (lastPublishedSideParent !== parentId) {
    lastPublishedSideParent = parentId
    avatarWindow.webContents.send('pet:side-snapshot', sideChat.takePublishSnapshot())
  }
}

// A streaming turn changes state once per model delta. Forwarding every delta makes the
// renderer re-render the whole panel (including its Markdown) per token and the window
// stops reacting to clicks until the turn ends. Publish at a fixed cadence instead; the
// scheduler always keeps the trailing send, so the final state still reaches the renderer.
// 80 ms: the stream still reads as typing, while every published frame costs a panel
// redraw plus a full-window composite twice over (GPU process + dwm) — the panel's
// measured ~16% at 20 Hz scales with the commit rate.
const snapshotScheduler = createSnapshotScheduler(flushSnapshot, 80)
let reconcilingSideParents = false
function publishSnapshot(): void {
  if (controller && !reconcilingSideParents) {
    reconcilingSideParents = true
    try { sideChat.discardMissingParents(controller.liveConversationIds()) }
    finally { reconcilingSideParents = false }
  }
  snapshotScheduler.publish()
}

// The CLI alone decides whether the SDK path exists; the key may arrive later
// from a saved model profile instead of the launch environment.
// One runtime (and one engine connection) per conversation that actually
// runs; the controller creates them on demand through this factory.
const createRuntime = (onChange: () => void, persistSession = true): AgentRuntime => new AgentRuntime(
  new NoteStore(projectRoot),
  apiKey ? new DeepSeekClient(apiKey) : undefined,
  onChange,
  claudeExecutable
    ? new ClaudeAgentClient(claudeExecutable, claudeKey ?? '', agentWorkspace, path.join(dataRoot, 'claude'), windowsMcpServers, persistSession)
    : undefined,
  agentWorkspace
)
controller = new ConversationController(
  new ConversationStore(dataRoot, electronSecretCodec()),
  createRuntime,
  () => publishSnapshot(),
  (error) => { console.error('Conversation background task failed:', error) },
  claudeKey || apiKey
    ? (source) => generateConversationTitle((claudeKey || apiKey)!, source, AbortSignal.timeout(20_000))
    : undefined,
  // The launch environment, materialized as the first editable profile.
  claudeKey
    ? { id: 'default', name: 'DeepSeek', baseUrl: CLAUDE_BASE_URL, apiKey: claudeKey,
        model: DEFAULT_CLAUDE_MODEL, smallModel: 'deepseek-flash' }
    : undefined
)
/** Post-turn reflection — fact extraction and growth observation — is side
 *  work: it reads the finished turn and writes memory, and nothing in the
 *  next message waits on it. A serial chain keeps it ordered and off the
 *  drain's critical path, so memory becomes visible one turn later instead
 *  of holding a queued message behind a model request for up to 20 seconds. */
let postTurnWork: Promise<void> = Promise.resolve()
function schedulePostTurn(task: () => Promise<void>): void {
  postTurnWork = postTurnWork.then(task).catch((error: unknown) => {
    console.error('Conversation post-turn work failed:', error)
  })
}

controller.setTurnHooks({
  memoryContext: () => memory.contextBlock(),
  afterSuccessfulTurn: (turn) => {
    schedulePostTurn(async () => {
      await memory.observeTurn({ ...turn, success: true, provider: await backgroundProvider() })
      const before = new Set((await growth.list()).map((item) => item.id))
      await growth.observeTurn(turn.conversationId, turn.timeline)
      const added = (await growth.list()).filter((item) => !before.has(item.id))
      if (added.length && Notification.isSupported()) {
        new Notification({ title: '小鲸发现一个改进机会', body: '可在设置的“成长”页查看依据，再决定是否实验。' }).show()
      }
    })
    return Promise.resolve()
  }
})

const sideSnapshotScheduler = createSnapshotScheduler(() => {
  if (avatarWindow && !avatarWindow.isDestroyed()) {
    avatarWindow.webContents.send('pet:side-snapshot', sideChat.takePublishSnapshot())
  }
}, 80)
const sideChat = new SideChatController(
  createRuntime,
  () => {
    const owner = activeController()
    const snapshot = owner.getSnapshot()
    const parentConversationId = activeSideChatParentId(owner.displayedConversationId(), snapshot.conversationLibrary)
    return {
      parentConversationId,
      mode: snapshot.mode,
      settings: snapshot.conversationLibrary.settings,
      history: parentConversationId ? owner.captureSideChatHistory() : []
    }
  },
  () => memory.contextBlock(),
  () => sideSnapshotScheduler.publish(),
  (error) => console.error('Temporary side chat failed:', error),
  () => activeController().displayedLiveConversationId(),
  () => activeController().currentSettings(),
  () => publishSnapshot()
)
controller.setSideBusyPredicate((id) => sideChat.isBusyForParent(id))
controller.setRuntimeConfigurationChangeListener((id) => {
  if (id) void sideChat.discardParent(id)
  else void sideChat.discardAll()
})

function discardSidesWithoutLiveParents(): void {
  sideChat.discardMissingParents(activeController().liveConversationIds())
}

function activeController(): ConversationController {
  if (!controller) throw new Error('会话库尚未就绪。')
  return controller
}

function rendererUrl(): string | undefined {
  const base = process.env.ELECTRON_RENDERER_URL
  return base ? `${base}/avatar.html` : undefined
}

function loadPage(win: BrowserWindow, balance = false): void {
  const url = rendererUrl()
  if (url) void win.loadURL(balance ? `${url}?balance=1` : url)
  else void win.loadFile(path.join(__dirname, '../renderer/avatar.html'), balance ? { query: { balance: '1' } } : undefined)
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
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    resizable: false,
    show: false,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'whale-tray-icon-pixel.ico')
      : path.join(projectRoot, 'src', 'renderer', 'assets', 'whale-tray-icon-pixel.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  if (process.platform === 'win32') win.setShape([avatarRegion(stageSize)])
  win.once('ready-to-show', () => win.show())
  win.on('move', syncBalancePosition)
  win.on('resize', syncBalancePosition)
  win.on('closed', () => {
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    avatarWindow = undefined
    app.quit()
  })
  loadPage(win)
  return win
}

function createBalanceWindow(): BrowserWindow {
  const avatar = avatarWindow
  if (!avatar || avatar.isDestroyed()) throw new Error('桌面角色尚未就绪。')
  const bounds = avatar.getBounds()
  const win = new BrowserWindow({
    parent: avatar,
    x: bounds.x + bounds.width - 452,
    y: bounds.y + bounds.height - 176,
    width: 284,
    height: 145,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
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
  // Wait for the card's first painted frame before showing the transparent window.
  win.once('ready-to-show', () => {
    balanceWindowReady = true
    if (balanceOpen && !win.isDestroyed()) {
      syncBalancePosition()
      win.showInactive()
    }
  })
  win.on('closed', () => {
    if (balanceWindow !== win) return
    balanceWindow = undefined
    balanceWindowReady = false
    balanceOpen = false
    if (avatarWindow && !avatarWindow.isDestroyed()) avatarWindow.webContents.send('pet:balance-open', false)
  })
  loadPage(win, true)
  return win
}

function createSettingsWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: '小鲸 设置',
    // 标题栏画在页面里（.settings-header），窗口不带系统边框。
    frame: false,
    width: 760,
    height: 560,
    minWidth: 560,
    minHeight: 420,
    show: false,
    backgroundColor: '#172d58',
    autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'whale-tray-icon-pixel.ico')
      : path.join(projectRoot, 'src', 'renderer', 'assets', 'whale-tray-icon-pixel.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
  win.on('closed', () => { if (settingsWindow === win) settingsWindow = undefined })
  const base = process.env.ELECTRON_RENDERER_URL
  if (base) void win.loadURL(`${base}/settings.html`)
  else void win.loadFile(path.join(__dirname, '../renderer/settings.html'))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

function setBalanceOpen(open: boolean): void {
  if (balanceOpen === open) return
  balanceOpen = open
  if (open) {
    if (!balanceWindow || balanceWindow.isDestroyed()) balanceWindow = createBalanceWindow()
    if (balanceWindowReady) {
      syncBalancePosition()
      balanceWindow.showInactive()
    }
  } else if (balanceWindow && !balanceWindow.isDestroyed()) {
    balanceWindow.hide()
  }
  avatarWindow?.webContents.send('pet:balance-open', open)
  if (balanceWindowReady && balanceWindow && !balanceWindow.isDestroyed()) {
    balanceWindow.webContents.send('pet:balance-open', open)
  }
}

function showPanel(): void {
  if (balanceOpen) setBalanceOpen(false)
  if (!panelOpen) {
    panelOpen = true
    applyPointerShape()
    avatarWindow?.webContents.send('pet:panel-open', true)
  }
  avatarWindow?.focus()
}

function openSettings(): void {
  if (!settingsWindow || settingsWindow.isDestroyed()) settingsWindow = createSettingsWindow()
  else {
    if (settingsWindow.isMinimized()) settingsWindow.restore()
    settingsWindow.show()
    settingsWindow.focus()
  }
}

function createOnboardingWindow(): BrowserWindow {
  const win = new BrowserWindow({
    title: '小鲸 首次配置',
    width: 560,
    height: 620,
    minWidth: 520,
    minHeight: 560,
    show: false,
    backgroundColor: '#172d58',
    autoHideMenuBar: true,
    icon: app.isPackaged
      ? path.join(process.resourcesPath, 'whale-tray-icon-pixel.ico')
      : path.join(projectRoot, 'src', 'renderer', 'assets', 'whale-tray-icon-pixel.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/onboarding.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => { if (!win.isDestroyed()) win.show() })
  win.on('closed', () => {
    // Closing without finishing is an explicit "later": remember it so the
    // wizard is not pushed again on every launch.
    if (!readOnboardingMarker(dataRoot)) writeOnboardingMarker(dataRoot, 'skipped')
    if (onboardingWindow === win) onboardingWindow = undefined
  })
  const base = process.env.ELECTRON_RENDERER_URL
  if (base) void win.loadURL(`${base}/onboarding.html`)
  else void win.loadFile(path.join(__dirname, '../renderer/onboarding.html'))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  return win
}

function openOnboarding(): void {
  if (!onboardingWindow || onboardingWindow.isDestroyed()) onboardingWindow = createOnboardingWindow()
  else {
    if (onboardingWindow.isMinimized()) onboardingWindow.restore()
    onboardingWindow.show()
    onboardingWindow.focus()
  }
}

function createTray(): void {
  const asset = app.isPackaged
    ? path.join(process.resourcesPath, 'whale-tray-icon-pixel-24.png')
    : path.join(projectRoot, 'src', 'renderer', 'assets', 'whale-tray-icon-pixel-24.png')
  const icon = nativeImage.createFromPath(asset)
  if (icon.isEmpty()) throw new Error(`通知区域图标资源不可用：${asset}`)
  contextMenu = Menu.buildFromTemplate([
    { label: '配置向导', click: openOnboarding },
    { label: '选项', click: openSettings },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray = new Tray(icon)
  tray.setToolTip('小鲸')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    avatarWindow?.show()
    showPanel()
  })
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

function conversationSettingsPatch(value: unknown): Partial<ConversationSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('会话设置无效。')
  const input = value as Record<string, unknown>
  if (Object.keys(input).some((key) => !['visibleConversationTabs', 'autoArchiveAfterDays', 'effort', 'goalMaxIterations', 'goalMaxMinutes', 'memoryEnabled'].includes(key))) throw new Error('会话设置无效。')
  const patch: Partial<ConversationSettings> = {}
  if (input.visibleConversationTabs !== undefined) {
    const tabs = input.visibleConversationTabs
    if (typeof tabs !== 'number' || !Number.isInteger(tabs) || tabs < 1 || tabs > 12) throw new Error('快捷切换数应为 1–12。')
    patch.visibleConversationTabs = tabs
  }
  if (input.autoArchiveAfterDays !== undefined) {
    const days = input.autoArchiveAfterDays
    if (days !== 0 && days !== 7 && days !== 14 && days !== 30) throw new Error('自动归档设置无效。')
    patch.autoArchiveAfterDays = days
  }
  if (input.effort !== undefined) {
    if (!isEffortLevel(input.effort)) throw new Error('思考强度设置无效。')
    patch.effort = input.effort
  }
  if (input.goalMaxIterations !== undefined) {
    const count = input.goalMaxIterations
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 300) throw new Error('目标轮数上限应为 1–300。')
    patch.goalMaxIterations = count
  }
  if (input.goalMaxMinutes !== undefined) {
    const minutes = input.goalMaxMinutes
    if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('目标时长上限应为 1–1440 分钟。')
    patch.goalMaxMinutes = minutes
  }
  if (input.memoryEnabled !== undefined) {
    if (typeof input.memoryEnabled !== 'boolean') throw new Error('记忆开关无效。')
    patch.memoryEnabled = input.memoryEnabled
  }
  return patch
}

let adoptedRestartTimer: NodeJS.Timeout | undefined
function restartWhenIdle(version: string): void {
  if (adoptedRestartTimer) clearInterval(adoptedRestartTimer)
  const executable = path.join(dataProjectRoot, 'release', `whale-companion-v${version}`, 'win-unpacked', 'Whale Companion Preview.exe')
  adoptedRestartTimer = setInterval(() => {
    if (!controller?.allConversationsIdle()) return
    void fsp.access(executable).then(() => {
      if (adoptedRestartTimer) clearInterval(adoptedRestartTimer)
      adoptedRestartTimer = undefined
      app.relaunch({ execPath: executable })
      app.quit()
    }).catch((error: unknown) => console.error('Adopted version restart failed:', error))
  }, 1500)
  adoptedRestartTimer.unref?.()
}

const AVATARS_DIR = path.join(dataRoot, 'avatars')
const AVATAR_MAX_BYTES = 2 * 1024 * 1024

/** Stores an avatar image (PNG/JPEG, by magic bytes) and swaps the settings
 *  reference, removing the previous file. */
async function storeAvatar(kind: 'user' | 'assistant', bytes: number[]): Promise<void> {
  const buffer = Buffer.from(bytes)
  if (buffer.length === 0 || buffer.length > AVATAR_MAX_BYTES) throw new Error('头像图片需小于 2 MB。')
  const isPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47
  const isJpeg = buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (!isPng && !isJpeg) throw new Error('头像仅支持 PNG 或 JPEG 图片。')
  const name = `${kind}-${Date.now()}.${isPng ? 'png' : 'jpg'}`
  mkdirSync(AVATARS_DIR, { recursive: true })
  await fsp.writeFile(path.join(AVATARS_DIR, name), buffer)
  const settings = activeController().getSnapshot().conversationLibrary.settings
  const previous = kind === 'user' ? settings.userAvatar : settings.assistantAvatar
  await activeController().updateSettings(kind === 'user' ? { userAvatar: name } : { assistantAvatar: name })
  if (previous && previous !== name) await fsp.rm(path.join(AVATARS_DIR, previous), { force: true })
}

async function readAvatarDataUrl(kind: 'user' | 'assistant'): Promise<string | null> {
  const settings = activeController().getSnapshot().conversationLibrary.settings
  const name = kind === 'user' ? settings.userAvatar : settings.assistantAvatar
  if (!name) return null
  try {
    const buffer = await fsp.readFile(path.join(AVATARS_DIR, name))
    const mime = name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${buffer.toString('base64')}`
  } catch {
    return null
  }
}

function registerIpc(): void {
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === avatarWindow?.webContents.id
  const resolveAttachments = async (items: UserAttachment[]): Promise<UserAttachment[]> => Promise.all(items.map(async (item) => {
    if (!item.path) return item
    const file = await verifyDroppedFilePath(item.path)
    return { ...item, path: file.path, name: file.name }
  }))
  // The settings window manages model profiles and avatars too — the data
  // lives beside its own settings — so those channels accept either window.
  // Everything else stays avatar-only on purpose.
  const modelTrusted = (event: Electron.IpcMainInvokeEvent): boolean => trusted(event) || settingsTrusted(event)
  const balanceTrusted = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === balanceWindow?.webContents.id
  const settingsTrusted = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === settingsWindow?.webContents.id
  const onboardingTrusted = (event: Electron.IpcMainInvokeEvent): boolean => event.sender.id === onboardingWindow?.webContents.id
  ipcMain.handle('pet:settings:get', async (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return publicSettings((await activeController().getLibraryState()).settings)
  })
  ipcMain.handle('pet:settings:update', (event, patch: unknown) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return activeController().updateSettings(conversationSettingsPatch(patch)).then((settings) => {
      memory.setEnabled(settings.memoryEnabled)
      discardSidesWithoutLiveParents()
      return publicSettings(settings)
    })
  })
  ipcMain.handle('pet:settings:version', (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return app.getVersion()
  })
  ipcMain.handle('pet:settings:close', (event) => {
    if (!settingsTrusted(event)) return
    settingsWindow?.close()
  })
  ipcMain.handle('pet:memory:list', (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return memory.list()
  })
  ipcMain.handle('pet:memory:set-enabled', async (event, enabled: unknown) => {
    if (!settingsTrusted(event) || typeof enabled !== 'boolean') throw new Error('记忆开关无效。')
    const settings = await activeController().updateSettings({ memoryEnabled: enabled })
    memory.setEnabled(settings.memoryEnabled)
    return settings.memoryEnabled
  })
  ipcMain.handle('pet:memory:update', (event, id: unknown, value: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string' || typeof value !== 'string') throw new Error('记忆修改请求无效。')
    return memory.update(id, value)
  })
  ipcMain.handle('pet:memory:delete', (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('记忆删除请求无效。')
    return memory.delete(id)
  })
  ipcMain.handle('pet:growth:status', async (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return { ...await growth.availability(), proposals: await growth.list() }
  })
  ipcMain.handle('pet:growth:propose', (event, title: unknown, objective: unknown, evidence: unknown) => {
    if (!settingsTrusted(event) || typeof title !== 'string' || typeof objective !== 'string' || typeof evidence !== 'string') throw new Error('改进提案无效。')
    return growth.propose(title, objective, evidence)
  })
  ipcMain.handle('pet:growth:experiment', (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('实验编号无效。')
    return growth.experiment(id)
  })
  ipcMain.handle('pet:growth:update-notes', (event, id: unknown, notes: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string' || typeof notes !== 'string') throw new Error('版本说明无效。')
    return growth.updateReleaseNotes(id, notes)
  })
  ipcMain.handle('pet:growth:adopt', async (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('采纳请求无效。')
    if (!activeController().allConversationsIdle() || sideChat.isBusy()) throw new Error('请等其他会话和临时会话完成或停止后再采纳。')
    const adopted = await growth.adopt(id)
    if (adopted.version) restartWhenIdle(adopted.version)
    return adopted
  })
  ipcMain.handle('pet:growth:publish', (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('发布请求无效。')
    return growth.publish(id)
  })
  ipcMain.handle('pet:growth:discard', (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('丢弃请求无效。')
    return growth.discard(id)
  })
  ipcMain.handle('pet:prepare-dropped-file', async (event, filePath: unknown) => {
    if (!trusted(event) || typeof filePath !== 'string') throw new Error('拖入文件无效。')
    return prepareDroppedFile(filePath)
  })
  ipcMain.handle('pet:prepare-pasted-file', async (event, request: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!request || typeof request !== 'object') throw new Error('粘贴内容无效。')
    const { name, data } = request as { name?: unknown; data?: unknown }
    if (typeof name !== 'string' || !name.trim() || name.length > 260 || typeof data !== 'string') throw new Error('粘贴内容无效。')
    return stagePastedAttachment(path.join(dataRoot, 'attachments'), name.trim(), data)
  })
  ipcMain.handle('pet:read-image-preview', async (event, filePath: unknown) => {
    if (!trusted(event) || typeof filePath !== 'string' || filePath.length > 32_000) throw new Error('预览请求无效。')
    const target = attachmentPreviewPath(path.join(dataRoot, 'attachments'), filePath)
    return target ? readImagePreview(target) : null
  })
  ipcMain.handle('pet:get-snapshot', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    return snapshotWithSideStatuses()
  })
  ipcMain.handle('pet:side:get', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    return sideChat.getSnapshot()
  })
  ipcMain.handle('pet:side:open', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    return sideChat.open()
  })
  ipcMain.handle('pet:side:set-expanded', (event, sessionId: unknown, expanded: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof expanded !== 'boolean') throw new Error('临时会话状态无效。')
    return sideChat.setExpanded(sessionId, expanded)
  })
  ipcMain.handle('pet:side:discard', (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') throw new Error('临时会话编号无效。')
    return sideChat.discard(sessionId)
  })
  ipcMain.handle('pet:side:send', async (event, sessionId: unknown, text: unknown, attachments: unknown, strategy: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof text !== 'string' ||
        !validAttachmentList(attachments ?? []) ||
        (strategy !== undefined && strategy !== 'queue' && strategy !== 'steer')) throw new Error('临时会话消息无效。')
    const resolved = await resolveAttachments((attachments ?? []) as UserAttachment[])
    await sideChat.send(sessionId, text, resolved, strategy as 'queue' | 'steer' | undefined)
  })
  ipcMain.handle('pet:side:stop', (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') throw new Error('临时会话编号无效。')
    sideChat.stop(sessionId)
  })
  ipcMain.handle('pet:side:interrupt', (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') throw new Error('临时会话编号无效。')
    return sideChat.interrupt(sessionId)
  })
  ipcMain.handle('pet:side:remove-queued', (event, sessionId: unknown, messageId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof messageId !== 'string') throw new Error('队列编号无效。')
    sideChat.removeQueued(sessionId, messageId)
  })
  ipcMain.handle('pet:side:steer-queued', (event, sessionId: unknown, messageId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof messageId !== 'string') throw new Error('队列编号无效。')
    return sideChat.steerQueued(sessionId, messageId)
  })
  ipcMain.handle('pet:side:approve-action', (event, sessionId: unknown, id: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof id !== 'string') throw new Error('操作编号无效。')
    return sideChat.approveAction(sessionId, id)
  })
  ipcMain.handle('pet:side:reject-action', (event, sessionId: unknown, id: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof id !== 'string') throw new Error('操作编号无效。')
    sideChat.rejectAction(sessionId, id)
  })
  ipcMain.handle('pet:side:answer-question', (event, sessionId: unknown, id: unknown, answers: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof id !== 'string' || !isAskAnswers(answers)) throw new Error('答案格式无效。')
    return sideChat.answerQuestion(sessionId, id, answers)
  })
  ipcMain.handle('pet:side:answer-plan', (event, sessionId: unknown, id: unknown, approved: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof id !== 'string' || typeof approved !== 'boolean') throw new Error('批准结果无效。')
    return sideChat.answerPlan(sessionId, id, approved)
  })
  ipcMain.handle('pet:side:get-context-usage', (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') throw new Error('临时会话编号无效。')
    return sideChat.getContextUsage(sessionId)
  })
  ipcMain.handle('pet:side:compact', (event, sessionId: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string') throw new Error('临时会话编号无效。')
    return sideChat.compact(sessionId)
  })
  ipcMain.handle('pet:side:set-model-mode', (event, sessionId: unknown, mode: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || (mode !== 'demo' && mode !== 'live' && mode !== 'claude_code')) throw new Error('模型选项无效。')
    sideChat.setModelMode(sessionId, mode)
  })
  ipcMain.handle('pet:side:set-plan-mode', (event, sessionId: unknown, on: unknown) => {
    if (!trusted(event) || typeof sessionId !== 'string' || typeof on !== 'boolean') throw new Error('计划模式设置无效。')
    return sideChat.setPlanMode(sessionId, on)
  })
  ipcMain.handle('pet:send-message', async (event, text: unknown, attachments: unknown, strategy: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    if (typeof text !== 'string') throw new Error('消息必须是文本。')
    if (!validAttachmentList(attachments ?? [])) {
      throw new Error('附件数据无效。')
    }
    if (strategy !== undefined && strategy !== 'queue' && strategy !== 'steer') throw new Error('发送方式无效。')
    const slash = parseAppSlashCommand(text)
    if (slash) {
      if (slash.name === 'side' || slash.name === 'btw') {
        const originId = activeController().displayedConversationId()
        const originEpoch = activeController().displayedConversationEpoch()
        if (conversationId !== undefined && conversationId !== originId) {
          throw new Error('主会话已切换，请重新发送。')
        }
        const resolved = await resolveAttachments((attachments ?? []) as UserAttachment[])
        if (activeController().displayedConversationId() !== originId ||
            activeController().displayedConversationEpoch() !== originEpoch) throw new Error('主会话已切换，请重新发送。')
        // An attachment alone is a valid first question. The controller
        // validates before opening and rolls back a failed send atomically.
        await sideChat.openWithMessage(slash.args, resolved)
        return
      }
      if ((attachments as Array<unknown> | undefined)?.length) throw new Error('应用命令不能附带文件。')
      if (slash.name !== 'new' && slash.args) throw new Error(`/${slash.name} 不接受额外参数。`)
      if (slash.name === 'new') {
        if (slash.args.length > 60 || /[\r\n]/u.test(slash.args)) throw new Error('新对话标题最多 60 字，且不能换行。')
        await activeController().createConversation(slash.args || undefined)
      } else if (slash.name === 'compact') {
        await activeController().compactConversation()
      } else {
        avatarWindow?.webContents.send('pet:slash-ui', slash.name)
      }
      return
    }
    const resolved = await resolveAttachments((attachments ?? []) as UserAttachment[])
    await activeController().sendMessage(text, resolved, strategy as 'queue' | 'steer' | undefined, conversationId as string | undefined)
  })
  ipcMain.handle('pet:create-conversation', async (event, title: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (title !== undefined && typeof title !== 'string') throw new Error('标题无效。')
    await activeController().createConversation(title as string | undefined)
  })
  ipcMain.handle('pet:select-conversation', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('会话编号无效。')
    await activeController().selectConversation(id)
  })
  ipcMain.handle('pet:rename-conversation', async (event, id: unknown, title: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || typeof title !== 'string') throw new Error('会话标题无效。')
    await activeController().renameConversation(id, title)
  })
  ipcMain.handle('pet:set-conversation-pinned', async (event, id: unknown, pinned: unknown) => {
    if (!trusted(event) || typeof id !== 'string' || typeof pinned !== 'boolean') throw new Error('置顶请求无效。')
    await activeController().setConversationPinned(id, pinned)
  })
  ipcMain.handle('pet:set-tab-order', async (event, ids: unknown) => {
    if (!trusted(event) || !Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error('标签顺序无效。')
    await activeController().setTabOrder(ids as string[])
  })
  ipcMain.handle('pet:archive-conversation', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('会话编号无效。')
    await activeController().archiveConversation(id)
    await sideChat.discardParent(id)
  })
  ipcMain.handle('pet:restore-conversation', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('会话编号无效。')
    await activeController().restoreConversation(id)
  })
  ipcMain.handle('pet:delete-conversation', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('会话编号无效。')
    await activeController().deleteConversation(id)
    await sideChat.discardParent(id)
  })
  ipcMain.handle('pet:batch-manage-conversations', async (event, action: unknown, ids: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if ((action !== 'archive' && action !== 'restore' && action !== 'delete' &&
         action !== 'pin' && action !== 'unpin') ||
        !Array.isArray(ids) || ids.length > MAX_BATCH_CONVERSATIONS ||
        ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128)) {
      throw new Error('批量会话请求无效。')
    }
    const result = await activeController().batchManageConversations(action, ids as string[])
    if (action === 'archive' || action === 'delete') {
      await Promise.all(result.outcomes.filter((item) => item.status === 'updated')
        .map((item) => sideChat.discardParent(item.id)))
    }
    return result
  })
  ipcMain.handle('pet:delete-turn', async (event, conversationId: unknown, userEntryId: unknown) => {
    if (!trusted(event) || typeof conversationId !== 'string' || typeof userEntryId !== 'string') throw new Error('删除请求无效。')
    await activeController().deleteTurn(conversationId, userEntryId)
  })
  ipcMain.handle('pet:get-context-usage', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().getContextUsage(conversationId as string | undefined)
  })
  ipcMain.handle('pet:compact-conversation', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().compactConversation(conversationId as string | undefined)
  })
  ipcMain.handle('pet:list-claude-workflows', async (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    await activeController().initialize()
    const claudeMode = activeController().getSnapshot().mode === 'claude_code' && Boolean(claudeExecutable)
    const workflows = claudeMode
      ? await listClaudeWorkflows({ projectRoot: agentWorkspace, userConfigRoot: path.join(userHome, '.claude') })
      : []
    const options = new Map<string, ClaudeWorkflowOption>(workflows.map(({ name, description, kind, source }) => [
      name.toLowerCase(), { name, description, kind, source }
    ]))
    const catalog = claudeMode ? activeController().commandCatalog() : undefined
    for (const [kind, names] of [['command', catalog?.commands ?? []], ['skill', catalog?.skills ?? []]] as const) {
      for (const rawName of names) {
        const name = rawName.replace(/^[/\$]/u, '').trim()
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/u.test(name) || options.has(name.toLowerCase())) continue
        options.set(name.toLowerCase(), { name, description: kind === 'skill' ? 'Claude Code 技能' : 'Claude Code 命令', kind, source: 'builtin' })
      }
    }
    const appCommands = APP_SLASH_COMMANDS.filter((command) => claudeMode || command.name !== 'compact')
    for (const command of appCommands) options.set(command.name, command)
    return [
      ...appCommands,
      ...[...options.values()].filter((option) => !appCommands.some((command) => command.name === option.name.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name))
    ]
  })
  ipcMain.handle('pet:search-workspace-files', (event, query: unknown) => {
    if (!trusted(event) || typeof query !== 'string' || query.length > 120) throw new Error('文件搜索条件无效。')
    return searchWorkspaceFiles(agentWorkspace, query)
  })
  ipcMain.handle('pet:search-conversations', async (event, query: unknown, archived: unknown) => {
    if (!trusted(event) || typeof query !== 'string' || query.length > 200 ||
        (archived !== undefined && typeof archived !== 'boolean')) throw new Error('搜索条件无效。')
    const matches = await activeController().listConversations({ query, archived: archived as boolean | undefined })
    return sideChat.withSideStatuses(matches)
  })
  ipcMain.handle('pet:remove-queued-message', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('队列编号无效。')
    await activeController().removeQueued(id)
  })
  ipcMain.handle('pet:steer-queued-message', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('队列编号无效。')
    await activeController().steerQueued(id)
  })
  ipcMain.handle('pet:approve-action', (event, id: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('操作编号无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().approveAction(id, conversationId as string | undefined)
  })
  ipcMain.handle('pet:reject-action', (event, id: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('操作编号无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().rejectAction(id, conversationId as string | undefined)
  })
  ipcMain.handle('pet:answer-question', (event, id: unknown, answers: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('问答编号无效。')
    if (!isAskAnswers(answers)) throw new Error('答案格式无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().answerQuestion(id, answers, conversationId as string | undefined)
  })
  ipcMain.handle('pet:answer-plan', (event, id: unknown, approved: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('计划编号无效。')
    if (typeof approved !== 'boolean') throw new Error('批准结果无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().answerPlan(id, approved, conversationId as string | undefined)
  })
  ipcMain.handle('pet:save-draft', (event, conversationId: unknown, text: unknown) => {
    if (!trusted(event) || typeof conversationId !== 'string' || typeof text !== 'string') throw new Error('草稿保存请求无效。')
    return activeController().saveDraft(conversationId, text)
  })
  ipcMain.handle('pet:get-draft', (event, conversationId: unknown) => {
    if (!trusted(event) || typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().getDraft(conversationId)
  })
  ipcMain.handle('pet:clear-goal', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().clearGoal(conversationId as string | undefined)
  })
  ipcMain.handle('pet:stop', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().stop(conversationId as string | undefined)
  })
  ipcMain.handle('pet:interrupt-turn', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().interruptTurn(conversationId as string | undefined)
  })
  ipcMain.handle('pet:save-model-profile', (event, profile: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (!isModelProfile(profile)) throw new Error('模型配置格式无效。')
    return activeController().saveModelProfile(profile)
  })
  ipcMain.handle('pet:delete-model-profile', (event, id: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('模型配置编号无效。')
    return activeController().deleteModelProfile(id)
  })
  ipcMain.handle('pet:set-model-profile', (event, id: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (id !== null && typeof id !== 'string') throw new Error('模型配置编号无效。')
    return activeController().setModelProfile(id)
  })
  ipcMain.handle('pet:test-model-profile', async (event, profile: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (!isModelProfile(profile)) throw new Error('模型配置格式无效。')
    const saved = (await activeController().getLibraryState()).settings.modelProfiles.find((item) => item.id === profile.id)
    const apiKey = profile.apiKey || (saved?.baseUrl === profile.baseUrl ? saved.apiKey : '')
    if (!apiKey) throw new Error('请先输入 API Key。')
    return probeAnthropicEndpoint({ ...profile, apiKey })
  })
  ipcMain.handle('pet:set-auto-title', (event, on: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof on !== 'boolean') throw new Error('设置无效。')
    return activeController().updateSettings({ enableAutoTitleGeneration: on }).then(publicSettings)
  })
  ipcMain.handle('pet:set-timestamps', (event, on: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof on !== 'boolean') throw new Error('设置无效。')
    return activeController().updateSettings({ showMessageTimestamps: on }).then(publicSettings)
  })
  ipcMain.handle('pet:set-user-names', (event, userName: unknown, assistantName: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof userName !== 'string' || typeof assistantName !== 'string') throw new Error('称呼无效。')
    return activeController().updateSettings({ userName, assistantName }).then(publicSettings)
  })
  ipcMain.handle('pet:set-avatar', async (event, kind: unknown, bytes: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (kind !== 'user' && kind !== 'assistant') throw new Error('头像类型无效。')
    if (!Array.isArray(bytes) || !bytes.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)) {
      throw new Error('头像数据无效。')
    }
    await storeAvatar(kind, bytes as number[])
  })
  ipcMain.handle('pet:read-avatar', (event, kind: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (kind !== 'user' && kind !== 'assistant') throw new Error('头像类型无效。')
    return readAvatarDataUrl(kind)
  })
  ipcMain.handle('pet:open-settings', (event) => { if (trusted(event)) openSettings() })
  ipcMain.handle('pet:open-onboarding', (event) => { if (trusted(event)) openOnboarding() })
  // The onboarding wizard's narrow channels: one DeepSeek key, one save, the
  // fixed guide pages, and the outcome marker. Keys travel one way only.
  ipcMain.handle('pet:onboarding:test', async (event, apiKey: unknown, model: unknown) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    const key = typeof apiKey === 'string' ? normalizeApiKey(apiKey) : ''
    const chosen = deepSeekModel(model)
    if (!key || key.length > 512 || !chosen) throw new Error('API Key 无效。')
    return probeAnthropicEndpoint(deepSeekProfile(key, chosen))
  })
  ipcMain.handle('pet:onboarding:save', async (event, apiKey: unknown, model: unknown) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    const key = typeof apiKey === 'string' ? normalizeApiKey(apiKey) : ''
    const chosen = deepSeekModel(model)
    if (!key || key.length > 512 || !chosen) throw new Error('API Key 无效。')
    const controller = activeController()
    const settings = (await controller.getLibraryState()).settings
    // Re-running the wizard updates the existing DeepSeek profile instead of
    // stacking a duplicate: match on the shared base URL.
    const existing = settings.modelProfiles.find((profile) => profile.baseUrl === deepSeekBaseUrl())
    const profile = deepSeekProfile(key, chosen, existing?.id)
    await controller.saveModelProfile(profile)
    if (settings.activeModelProfileId !== profile.id) await controller.setModelProfile(profile.id)
    writeOnboardingMarker(dataRoot, 'completed')
  })
  ipcMain.handle('pet:onboarding:open', (event, page: unknown) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof page !== 'string' || !(page in ONBOARDING_PAGES)) throw new Error('页面无效。')
    void shell.openExternal(ONBOARDING_PAGES[page as OnboardingPage])
  })
  ipcMain.handle('pet:onboarding:finish', (event, outcome: unknown) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    if (outcome !== 'completed' && outcome !== 'skipped') throw new Error('状态无效。')
    writeOnboardingMarker(dataRoot, outcome)
  })
  ipcMain.handle('pet:show-panel', (event) => { if (trusted(event)) showPanel() })
  ipcMain.handle('pet:hide-panel', (event) => { if (trusted(event)) hidePanel() })
  ipcMain.handle('pet:get-panel-open', (event) => { if (!trusted(event)) throw new Error('无效的界面请求。'); return panelOpen })
  ipcMain.handle('pet:show-context-menu', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (avatarWindow && contextMenu) contextMenu.popup({ window: avatarWindow })
  })
  ipcMain.handle('pet:set-balance-open', (event, open: unknown) => {
    if (!trusted(event) && !balanceTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof open !== 'boolean') throw new Error('余额卡片状态无效。')
    setBalanceOpen(open)
  })
  ipcMain.handle('pet:toggle-balance', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    // Toggled here, not by the renderer: the renderer's cached flag can drift
    // from this one, and the guard in setBalanceOpen would then swallow every
    // follow-up flip — the card would open and never close again.
    setBalanceOpen(!balanceOpen)
  })
  ipcMain.handle('pet:get-balance', async (event) => {
    if (!trusted(event) && !balanceTrusted(event)) throw new Error('无效的界面请求。')
    const settings = (await activeController().getLibraryState()).settings
    const key = getDeepSeekBalanceKey(settings, claudeKey)
    if (!key) throw new Error('请在设置中添加 DeepSeek API Key。')
    return fetchDeepSeekBalance(key)
  })
  ipcMain.handle('pet:open-external', async (event, value: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof value !== 'string' || value.length > 2_000) throw new Error('无效的链接。')
    const url = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('不支持的链接。')
    await shell.openExternal(url.href)
  })
  ipcMain.handle('pet:set-bubble-layout', (event, layout: unknown, height: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (layout !== 'empty' && layout !== 'composer' && layout !== 'composer_attachments' && layout !== 'composer_models' && layout !== 'full') throw new Error('气泡布局无效。')
    if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height) || height < 100 || height > 260)) throw new Error('气泡高度无效。')
    const nextHeight = (layout === 'composer' || layout === 'composer_attachments') && typeof height === 'number' ? Math.round(height) : undefined
    if (bubbleLayout === layout && compactBubbleHeight === nextHeight) return
    const size = avatarWindow?.getBounds() ?? stageSize
    const previous = bubbleRegion(bubbleLayout, size)
    bubbleLayout = layout
    compactBubbleHeight = nextHeight
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    const next = bubbleRegion(layout, size)
    if (panelOpen && next.width * next.height < previous.width * previous.height) {
      shapeShrinkTimer = setTimeout(() => {
        shapeShrinkTimer = undefined
        applyPointerShape()
      }, 240)
    } else {
      applyPointerShape()
    }
  })
  ipcMain.handle('pet:set-bubble-expanded', (event, expanded: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof expanded !== 'boolean') throw new Error('气泡尺寸无效。')
    setBubbleExpanded(expanded)
  })
  ipcMain.handle('pet:set-plan-mode', async (event, on: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof on !== 'boolean') throw new Error('计划模式设置无效。')
    await activeController().setPlanMode(on)
  })
  ipcMain.handle('pet:set-effort', async (event, level: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!isEffortLevel(level)) throw new Error('思考强度无效。')
    await activeController().updateSettings({ effort: level })
  })
  ipcMain.handle('pet:set-model-mode', (event, mode: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (mode !== 'demo' && mode !== 'live' && mode !== 'claude_code') throw new Error('模型选项无效。')
    return activeController().setModelMode(mode)
  })
  ipcMain.handle('pet:set-avatar-state', (event, state: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    if (state !== 'idle' && state !== 'thinking' && state !== 'listening' && state !== 'speaking' && state !== 'acting' && state !== 'success' && state !== 'error') {
      throw new Error('角色状态无效。')
    }
    const taskStatus = activeController().displayedRuntime()?.getSnapshot().taskStatus ?? 'idle'
    if (state === 'idle' && ['planning', 'awaiting_approval', 'executing', 'verifying'].includes(taskStatus)) {
      throw new Error('任务进行中时不能将角色状态设为待机。')
    }
    rendererAvatarState = state === 'idle' ? undefined : state
    publishSnapshot()
  })
  ipcMain.handle('pet:get-voice-config', (event) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return {}
    return {
      siliconFlowAvailable: Boolean(process.env.SILICONFLOW_API_KEY),
    }
  })
  ipcMain.handle('pet:transcribe-audio', async (event, request: unknown) => {
    voiceLog('[ipc] transcribe-audio called', { hasRequest: !!request, senderId: event.sender.id })
    if (event.sender.id !== avatarWindow?.webContents.id) throw new Error('无效的界面请求。')
    if (!request || typeof request !== 'object') throw new Error('转写请求无效。')
    const req = request as { bytes?: number[]; mimeType?: string }
    voiceLog('[ipc] request', { bytesLen: req.bytes?.length, mimeType: req.mimeType })
    if (!Array.isArray(req.bytes) || req.bytes.length === 0) throw new Error('音频数据无效。')
    const voiceKey = process.env.SILICONFLOW_API_KEY
    if (!voiceKey) throw new Error('未配置 SiliconFlow API Key。')
    try {
      const result = await transcribeAudio({
        bytes: req.bytes,
        mimeType: req.mimeType ?? 'audio/webm',
        apiKey: voiceKey,
        model: process.env.SILICONFLOW_MODEL,
        baseUrl: process.env.SILICONFLOW_BASE_URL,
      })
      voiceLog('[ipc] transcribe success', { textLength: result.text?.length ?? 0 })
      return result
    } catch (error) {
      voiceLog('[ipc] transcribe failed', { kind: error instanceof Error ? error.name : 'UnknownError' })
      throw error
    }
  })
  ipcMain.handle('pet:voice-log', (event, level: unknown, message: unknown, data: unknown) => {
    if (event.sender.id !== avatarWindow?.webContents.id) return
    const allowed = new Set(['[asr] mediaRecorder stop', '[asr] mediaRecorder error', '[asr] transcribe start', '[asr] transcribe result', '[asr] transcribe error'])
    if (typeof message !== 'string' || !allowed.has(message)) return
    const fields = data && typeof data === 'object' ? data as Record<string, unknown> : {}
    const safe = Object.fromEntries(['chunks', 'totalSize', 'bytes', 'textLength'].flatMap((key) =>
      typeof fields[key] === 'number' && Number.isFinite(fields[key]) && Number(fields[key]) >= 0 ? [[key, fields[key]]] : []))
    voiceLog(message, { level: level === 'error' ? 'error' : 'info', ...safe })
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
      width: dragOrigin.bounds.width,
      height: dragOrigin.bounds.height
    })
    syncBalancePosition()
  })
  ipcMain.handle('pet:end-drag', (event) => {
    if (trusted(event)) dragOrigin = undefined
  })
}

const ownsSingleInstance = app.requestSingleInstanceLock()
if (!ownsSingleInstance) app.quit()
else app.on('second-instance', () => {
  avatarWindow?.show()
  showPanel()
})

if (ownsSingleInstance) void app.whenReady().then(async () => {
  await linkClaudeUserResources(path.join(dataRoot, 'claude'), userHome).catch((error: unknown) => {
    console.warn('Claude user resource links unavailable:', error instanceof Error ? error.message : String(error))
  })
  await activeController().initialize()
  memory.setEnabled((await activeController().getLibraryState()).settings.memoryEnabled)
  await memory.initialize()
  registerIpc()
  avatarWindow = createAvatarWindow()
  createTray()

  // First run with no model configured: let the pet appear first, then offer
  // the DeepSeek wizard. The marker file makes "later" a decision we remember.
  const onboardProfiles = (await activeController().getLibraryState()).settings.modelProfiles
  if (shouldOfferOnboarding(readOnboardingMarker(dataRoot), onboardProfiles.length)) {
    setTimeout(openOnboarding, 1000)
  }

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
          voiceLog('[selftest] result', { textLength: result.text?.length ?? 0 })
        } else {
          voiceLogError('[selftest] no SILICONFLOW_API_KEY', new Error('missing key'))
        }
      } else {
        voiceLogError('[selftest] test audio not found', { testAudio })
      }
    } catch (error) {
      voiceLog('[selftest] failed', { kind: error instanceof Error ? error.name : 'UnknownError' })
    } finally {
      voiceLog('[selftest] done, quitting', undefined)
      setTimeout(() => app.quit(), 500)
    }
  }
}).catch((error: unknown) => {
  if (error instanceof SecretProtectionUnavailableError) {
    dialog.showErrorBox('小鲸无法读取加密配置', 'Windows 密钥保护暂不可用。原配置未更改，请稍后重试。')
  }
  console.error('Desktop companion failed to start:', error)
  app.quit()
})

app.on('before-quit', () => {
  controller?.stopAll()
  void sideChat.discardAll()
  if (balanceWindow && !balanceWindow.isDestroyed()) balanceWindow.destroy()
  balanceWindow = undefined
  tray?.destroy()
  tray = undefined
})

app.on('window-all-closed', () => app.quit())
