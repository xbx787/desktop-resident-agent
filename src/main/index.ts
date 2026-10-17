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
import { BUBBLE_BOTTOM, computeStageBounds, STAGE_HEIGHT, STAGE_WIDTH } from './stage-bounds'
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
import { findSourceProjectRoot, isUsableWorkspace, readSavedWorkspace, resolveAgentWorkspace, writeSavedWorkspace } from './workspace-root'
import { isEffortLevel } from '../shared/effort'
import type { AvatarSize, BubbleLayout, ClaudeWorkflowOption, ConversationSettings, UiSize, UserAttachment } from '../shared/contracts'
import { isApprovalMode, isAutoCompactPercent, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH } from '../shared/contracts'
import { isPersonaId } from '../shared/personas'

const projectRoot = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..')
const dataProjectRoot = findSourceProjectRoot(projectRoot) ?? projectRoot
// 隔离冒烟测试/便携数据目录：显式指定时不再使用项目下的 data/。
const dataRootOverride = process.env.DESKTOP_PET_DATA?.trim()
const dataRoot = dataRootOverride && path.isAbsolute(dataRootOverride)
  ? dataRootOverride
  : path.join(dataProjectRoot, 'data')
const userHome = homedir()
// The wizard's saved choice survives a cleared environment variable; an
// explicit DESKTOP_PET_WORKSPACE still wins so advanced setups keep control.
let agentWorkspace = resolveAgentWorkspace(projectRoot, app.isPackaged, process.env, userHome, readSavedWorkspace(dataRoot))
const userDataDirectory = path.join(dataRoot, 'electron')
mkdirSync(userDataDirectory, { recursive: true })
mkdirSync(path.join(dataRoot, 'claude'), { recursive: true })
// A fresh install ships with an editable personal-settings file for the
// engine; existing files are the user's and never touched (see claude-memory).
seedClaudeMemory(path.join(dataRoot, 'claude'))
app.setPath('userData', userDataDirectory)
if (process.platform === 'win32') app.setAppUserModelId('local.desktop.resident.agent')

let avatarWindow: BrowserWindow | undefined
/** 对话面板独立成窗：透明面积只剩面板本身，头像窗可以缩到角色大小。 */
let panelWindow: BrowserWindow | undefined
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
/** 用户拖出来的展开面板尺寸；空表示用出厂的全高面板。 */
let bubblePanelSize: { width: number; height: number } | undefined
/** 界面字号档；窗口加载时灌一次，之后设置窗口一改就广播。 */
let currentUiSize: UiSize = 'small'
/** 人物大小档：决定人物脚底到窗口底的透明余量，拖动时用来算底部允许量。 */
let currentAvatarSize: AvatarSize = 'small'
const AVATAR_BOTTOM_SLACK: Record<AvatarSize, number> = { small: 60, medium: 48.5, large: 36 }
/** 人物右缘到头像窗口右缘的透明余量（88px 锚点 − 可见宽度/2，再加 2px
 *  动画缓冲）。允许窗口向右伸出这么多，人物才能拖到屏幕最右边。 */
const AVATAR_RIGHT_SLACK: Record<AvatarSize, number> = { small: 37, medium: 32, large: 27 }
/** 人物可见区域在头像窗口里的位置：与 .avatar-portrait 的 top 6px 对齐，
 *  长边缩放到 AVATAR_CONTENT_SIZES，宽度按原图 1016/1218 的比例。 */
const AVATAR_VISIBLE_BOX: Record<AvatarSize, { width: number; height: number; top: number }> = {
  small: { width: 106.7, height: 128, top: 6 },
  medium: { width: 116.4, height: 140, top: 6 },
  large: { width: 126.8, height: 152, top: 6 }
}
/** 余额卡宽度；窗口再向右留 8px 给指向人物的小三角。 */
const BALANCE_CARD_WIDTH = 240
const BALANCE_POINTER = 8
/** 卡片比人物可见高度再矮一截，上下各留 8px，避免看过去比人物长。 */
const BALANCE_INSET_Y = 16
/** 人物图片的视觉重心比几何中心偏上，卡片跟着上提一点才看着齐。 */
const BALANCE_LIFT = 6
/** 三角尖到角色左缘的呼吸间距。 */
const BALANCE_GAP = 4
/** 渲染器上报的可见人物矩形，按右/下偏移保存——窗口缩放时命中形状跟着
 *  右下角走，不会在拖动过程中错位。 */
let avatarBox: { right: number; bottom: number; width: number; height: number } | undefined
let dragOrigin: { cursor: Electron.Point; bounds: Electron.Rectangle } | undefined
let shapeShrinkTimer: NodeJS.Timeout | undefined
let rendererAvatarState: import('../shared/contracts').AvatarState | undefined

// Keep the avatar's window origin and width stable while its cards open/close.
// The unused area stays transparent and outside the shaped hit regions.
const stageSize = { width: STAGE_WIDTH, height: STAGE_HEIGHT }
/** 头像窗口只包住角色和状态点；不再跟随整个舞台矩形。 */
const AVATAR_WINDOW_WIDTH = 200
const AVATAR_WINDOW_HEIGHT = 220
/** 逻辑舞台：面板按它计算位置，头像窗口贴着它的右下角。 */
let stageBounds: Electron.Rectangle | undefined

function avatarRegion(size: { width: number; height: number }): Electron.Rectangle {
  // 图片裁掉透明边后，命中区跟着渲染器量出的可见矩形走；启动最初的几帧
  // 还没有上报，先用旧的右下角位置兜底。偏移量按右/下存储，窗口一变大
  // 形状就跟着右下角走，拖动缩放时不会来回跳。
  if (avatarBox) return {
    x: size.width - avatarBox.right - avatarBox.width,
    y: size.height - avatarBox.bottom - avatarBox.height,
    width: avatarBox.width,
    height: avatarBox.height
  }
  return { x: size.width - 168, y: size.height - 186, width: 160, height: 180 }
}

/** 面板窗口底部留给小三角的空间。三角旋转 45° 后对角尖会伸到 9px 左右，
 *  7px 会把尖端削掉。 */
const TRIANGLE_ROOM = 10

function bubbleRegion(layout: BubbleLayout, size: { width: number; height: number }, compactHeight = compactBubbleHeight): Electron.Rectangle {
  // BUBBLE_BOTTOM 是面板底边到舞台底的距离；额外的 TRIANGLE_ROOM 盖住小三角。
  if (bubbleExpanded) return { x: 10, y: 0, width: size.width - 20, height: size.height - BUBBLE_BOTTOM + TRIANGLE_ROOM }
  switch (layout) {
    case 'empty': return { x: size.width - 120, y: size.height - BUBBLE_BOTTOM - 56, width: 64, height: 56 + TRIANGLE_ROOM }
    case 'composer':
    case 'composer_attachments': {
      const height = compactHeight ?? (layout === 'composer' ? 206 : 232)
      return { x: size.width - 342, y: size.height - BUBBLE_BOTTOM - height, width: 332, height: height + TRIANGLE_ROOM }
    }
    case 'composer_models': return { x: size.width - 342, y: size.height - BUBBLE_BOTTOM - 238, width: 332, height: 238 + TRIANGLE_ROOM }
    case 'full': return { x: size.width - 366, y: size.height - BUBBLE_BOTTOM - 358, width: 356, height: 358 + TRIANGLE_ROOM }
  }
}

function applyPointerShape(): void {
  const win = avatarWindow
  if (!win || win.isDestroyed() || process.platform !== 'win32') return
  // 头像窗口只有 200×220，命中形状取窗口局部坐标；面板窗口本身就是一个
  // 贴合面板的矩形，不需要再裁剪。
  win.setShape([avatarRegion(win.getBounds())])
}

/** 面板窗口只包住面板矩形（逻辑舞台里的 bubbleRegion）。 */
function syncPanelBounds(): void {
  const stage = stageBounds
  const panel = panelWindow
  if (!stage || !panel || panel.isDestroyed()) return
  const region = bubbleRegion(bubbleLayout, stage)
  const target = { x: stage.x + region.x, y: stage.y + region.y, width: region.width, height: region.height }
  const current = panel.getBounds()
  if (current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height) return
  panel.setBounds(target, false)
}

/** 余额卡与人物可见区域对齐：高度随当前姿势和三档大小变化，顶部与人物
 *  顶部齐平，右侧三角尖离角色左缘 4px。优先用渲染器上报的真实命中框
 *  （高 12px 是按压/呼吸缓冲，减掉才是可见高度）。 */
function balanceBoundsFor(bounds: Electron.Rectangle): Electron.Rectangle {
  const width = BALANCE_CARD_WIDTH + BALANCE_POINTER
  let roleLeft: number
  let roleTop: number
  let roleHeight: number
  if (avatarBox) {
    roleLeft = bounds.x + (bounds.width - avatarBox.right - avatarBox.width)
    roleTop = bounds.y + (bounds.height - avatarBox.bottom - avatarBox.height) + 6
    roleHeight = Math.max(80, avatarBox.height - 12)
  } else {
    const visible = AVATAR_VISIBLE_BOX[currentAvatarSize] ?? AVATAR_VISIBLE_BOX.small
    roleLeft = bounds.x + bounds.width - 88 - visible.width / 2
    roleTop = bounds.y + visible.top
    roleHeight = visible.height
  }
  const height = Math.max(96, Math.round(roleHeight) - BALANCE_INSET_Y)
  return {
    x: Math.round(roleLeft - BALANCE_GAP - width),
    y: Math.round(roleTop + BALANCE_INSET_Y / 2 - BALANCE_LIFT),
    width,
    height
  }
}

function syncBalancePosition(): void {
  const avatar = avatarWindow
  const balance = balanceWindow
  if (!avatar || avatar.isDestroyed() || !balance || balance.isDestroyed()) return
  const target = balanceBoundsFor(avatar.getBounds())
  const current = balance.getBounds()
  if (current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height) return
  balance.setBounds(target, false)
}

function syncStageBounds(): void {
  const win = avatarWindow
  if (!win || win.isDestroyed()) return
  const avatar = win.getBounds()
  const bottom = avatar.y + avatar.height
  const work = screen.getDisplayNearestPoint({ x: avatar.x + avatar.width - 88, y: bottom - 96 }).workArea
  const next = computeStageBounds(avatar, work, bubbleExpanded, bubbleExpanded ? bubblePanelSize : undefined)
  // 头像窗口绝对不动：舞台直接按头像的右下角锚定，尺寸取布局计算值。
  // 展开/收起只改变面板窗口，人物在屏幕上的位置保持不变。
  stageBounds = {
    x: avatar.x + avatar.width - next.width,
    y: avatar.y + avatar.height - next.height,
    width: next.width,
    height: next.height
  }
  if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
  shapeShrinkTimer = undefined
  syncPanelBounds()
  syncBalancePosition()
  applyPointerShape()
}

function setBubbleExpanded(expanded: boolean): void {
  if (bubbleExpanded === expanded) return
  bubbleExpanded = expanded
  syncStageBounds()
}

/** 拖拽会把尺寸改得很密，停手 600ms 后统一落盘一次。 */
let panelSizeSaveTimer: NodeJS.Timeout | undefined
function schedulePanelSizeSave(): void {
  if (panelSizeSaveTimer) clearTimeout(panelSizeSaveTimer)
  panelSizeSaveTimer = setTimeout(() => {
    panelSizeSaveTimer = undefined
    if (!bubblePanelSize) return
    void activeController().updateSettings({ panelSize: { ...bubblePanelSize } })
      .catch((error: unknown) => console.warn('Save panel size failed:', error instanceof Error ? error.message : String(error)))
  }, 600)
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
  panelWindow?.webContents.send('pet:snapshot', snapshot)
  // A tab switch changes the child that belongs on screen. Send its full
  // snapshot after the main one so a renderer with stale tab state can still
  // recover even if side and main events were otherwise reordered.
  const parentId = activeSideChatParentId(controller.displayedConversationId(), snapshot.conversationLibrary)
  if (lastPublishedSideParent !== parentId) {
    lastPublishedSideParent = parentId
    const sideSnapshot = sideChat.takePublishSnapshot()
    avatarWindow.webContents.send('pet:side-snapshot', sideSnapshot)
    panelWindow?.webContents.send('pet:side-snapshot', sideSnapshot)
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

/** Opens the folder picker for the wizard or the settings window. */
async function pickWorkspaceDirectory(parent: BrowserWindow | undefined, current: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: '选择小鲸的工作目录',
    defaultPath: current,
    properties: ['openDirectory', 'createDirectory']
  }
  const result = parent
    ? await dialog.showOpenDialog(parent, options)
    : await dialog.showOpenDialog(options)
  return result.canceled ? null : result.filePaths[0] ?? null
}

/** The one migration path used by both the wizard and settings: refuse while
 *  work is running, drop every live runtime, persist the choice, then let the
 *  next send rebuild against the new cwd. No files are moved and no Windows
 *  environment variable is touched. */
async function migrateAgentWorkspace(next: string): Promise<string> {
  if (!isUsableWorkspace(next)) throw new Error('工作目录必须是存在的绝对路径。')
  const normalized = path.normalize(next.trim())
  // Confirming the auto-detected directory still records the choice, but does
  // not need to tear down any live connection.
  if (normalized === agentWorkspace) {
    writeSavedWorkspace(dataRoot, normalized)
    process.env.DESKTOP_PET_WORKSPACE = agentWorkspace
    return agentWorkspace
  }
  const active = activeController()
  if (!active.allConversationsIdle() || sideChat.isBusy()) throw new Error('有任务正在运行，完成后再迁移工作目录。')
  await active.resetForWorkspace()
  writeSavedWorkspace(dataRoot, normalized)
  agentWorkspace = normalized
  process.env.DESKTOP_PET_WORKSPACE = agentWorkspace
  return agentWorkspace
}

function rendererUrl(): string | undefined {
  const base = process.env.ELECTRON_RENDERER_URL
  return base ? `${base}/avatar.html` : undefined
}

function loadPage(win: BrowserWindow, balance = false): void {
  const url = rendererUrl()
  if (url) void win.loadURL(balance ? `${url}?balance=1` : url)
  else void win.loadFile(path.join(__dirname, '../renderer/avatar.html'), balance ? { query: { balance: '1' } } : undefined)
  sendUiSizeWhenLoaded(win)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

/** 每个窗口的 preload 都监听 pet:ui-size；页面一加载完就灌当前档位。 */
function sendUiSizeWhenLoaded(win: BrowserWindow): void {
  win.webContents.once('did-finish-load', () => {
    if (!win.isDestroyed()) win.webContents.send('pet:ui-size', currentUiSize)
  })
}

function broadcastUiSize(size: UiSize): void {
  currentUiSize = size
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('pet:ui-size', size)
  }
}

function createAvatarWindow(): BrowserWindow {
  const work = screen.getPrimaryDisplay().workArea
  const width = AVATAR_WINDOW_WIDTH
  const height = AVATAR_WINDOW_HEIGHT
  const x = work.x + work.width - width - 24
  const y = work.y + work.height - height - 24
  stageBounds = {
    x: work.x + work.width - STAGE_WIDTH - 24,
    y: work.y + work.height - STAGE_HEIGHT - 24,
    width: STAGE_WIDTH,
    height: STAGE_HEIGHT
  }
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
  if (process.platform === 'win32') win.setShape([avatarRegion({ width, height })])
  win.once('ready-to-show', () => win.show())
  win.on('move', () => {
    // 拖动的是头像窗口；逻辑舞台跟着它的右下角平移，面板窗口再跟着舞台走。
    if (stageBounds) {
      const bounds = win.getBounds()
      stageBounds = {
        ...stageBounds,
        x: bounds.x - (stageBounds.width - bounds.width),
        y: bounds.y - (stageBounds.height - bounds.height)
      }
    }
    syncPanelBounds()
    syncBalancePosition()
  })
  win.on('resize', () => { syncPanelBounds(); syncBalancePosition() })
  win.on('closed', () => {
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    avatarWindow = undefined
    app.quit()
  })
  loadPage(win)
  return win
}

function createPanelWindow(): BrowserWindow {
  const avatar = avatarWindow
  const bounds = avatar && !avatar.isDestroyed()
    ? avatar.getBounds()
    : { x: 0, y: 0, width: stageSize.width, height: stageSize.height }
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
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
  win.on('closed', () => { if (panelWindow === win) panelWindow = undefined })
  loadPanelPage(win)
  return win
}

function loadPanelPage(win: BrowserWindow): void {
  const url = rendererUrl()
  if (url) void win.loadURL(`${url}?mode=panel`)
  else void win.loadFile(path.join(__dirname, '../renderer/avatar.html'), { query: { mode: 'panel' } })
  sendUiSizeWhenLoaded(win)
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
}

function createBalanceWindow(): BrowserWindow {
  const avatar = avatarWindow
  if (!avatar || avatar.isDestroyed()) throw new Error('桌面角色尚未就绪。')
  const initial = balanceBoundsFor(avatar.getBounds())
  const win = new BrowserWindow({
    parent: avatar,
    x: initial.x,
    y: initial.y,
    width: initial.width,
    height: initial.height,
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
  sendUiSizeWhenLoaded(win)
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
    syncPanelBounds()
    applyPointerShape()
    // 面板是独立窗口：要真正激活它，输入框才能拿到键盘。
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.show()
      panelWindow.focus()
    }
    avatarWindow?.webContents.send('pet:panel-open', true)
  } else {
    panelWindow?.focus()
  }
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
  panelWindow?.hide()
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
  const editable = ['visibleConversationTabs', 'autoArchiveAfterDays', 'effort', 'goalMaxIterations', 'goalMaxMinutes', 'memoryEnabled', 'uiSize', 'avatarSize', 'webSearchEnabled', 'personaId', 'autoCompactPercent', 'assistantAvatar', 'enableAutoTitleGeneration', 'showMessageTimestamps', 'userName', 'assistantName']
  if (Object.keys(input).some((key) => !editable.includes(key))) throw new Error('会话设置无效。')
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
  if (input.uiSize !== undefined) {
    if (input.uiSize !== 'small' && input.uiSize !== 'medium' && input.uiSize !== 'large') throw new Error('界面尺寸设置无效。')
    patch.uiSize = input.uiSize
  }
  if (input.avatarSize !== undefined) {
    if (input.avatarSize !== 'small' && input.avatarSize !== 'medium' && input.avatarSize !== 'large') throw new Error('人物大小设置无效。')
    patch.avatarSize = input.avatarSize
  }
  if (input.webSearchEnabled !== undefined) {
    if (typeof input.webSearchEnabled !== 'boolean') throw new Error('联网搜索设置无效。')
    patch.webSearchEnabled = input.webSearchEnabled
  }
  if (input.personaId !== undefined) {
    if (!isPersonaId(input.personaId)) throw new Error('人设预设无效。')
    patch.personaId = input.personaId
  }
  if (input.autoCompactPercent !== undefined) {
    if (!isAutoCompactPercent(input.autoCompactPercent)) throw new Error('自动压缩阈值应为 50–90 之间的整数。')
    patch.autoCompactPercent = input.autoCompactPercent
  }
  // 切换人设时清掉自定义头像，让预设头像生效；上传仍走单独的字节通道。
  if (input.assistantAvatar !== undefined) {
    if (input.assistantAvatar !== null) throw new Error('对话头像只能通过上传修改。')
    patch.assistantAvatar = null
  }
  if (input.enableAutoTitleGeneration !== undefined) {
    if (typeof input.enableAutoTitleGeneration !== 'boolean') throw new Error('标题设置无效。')
    patch.enableAutoTitleGeneration = input.enableAutoTitleGeneration
  }
  if (input.showMessageTimestamps !== undefined) {
    if (typeof input.showMessageTimestamps !== 'boolean') throw new Error('时间戳设置无效。')
    patch.showMessageTimestamps = input.showMessageTimestamps
  }
  for (const key of ['userName', 'assistantName'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'string') throw new Error('称呼无效。')
    patch[key] = input[key]
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
  const trusted = (event: Electron.IpcMainInvokeEvent): boolean =>
    event.sender.id === avatarWindow?.webContents.id || event.sender.id === panelWindow?.webContents.id
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
      // 界面尺寸等显示设置也要立刻传给头像窗口里的小面板，不必等下一个事件。
      broadcastUiSize(settings.uiSize)
      currentAvatarSize = settings.avatarSize
      // 人物大小变了，余额卡的高度和位置要跟着重新对齐。
      syncBalancePosition()
      publishSnapshot()
      return publicSettings(settings)
    })
  })
  ipcMain.handle('pet:settings:workspace', (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return { path: agentWorkspace, saved: readSavedWorkspace(dataRoot) !== null }
  })
  ipcMain.handle('pet:settings:pick-workspace', async (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return pickWorkspaceDirectory(settingsWindow, agentWorkspace)
  })
  ipcMain.handle('pet:settings:migrate-workspace', async (event, next: unknown) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof next !== 'string') throw new Error('工作目录无效。')
    return { path: await migrateAgentWorkspace(next) }
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
  ipcMain.handle('pet:onboarding:workspace', (event) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    return agentWorkspace
  })
  ipcMain.handle('pet:onboarding:pick-workspace', async (event) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    return pickWorkspaceDirectory(onboardingWindow, agentWorkspace)
  })
  ipcMain.handle('pet:onboarding:set-workspace', async (event, next: unknown) => {
    if (!onboardingTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof next !== 'string') throw new Error('工作目录无效。')
    return { path: await migrateAgentWorkspace(next) }
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
    if (!trusted(event)) return
    if (layout !== 'empty' && layout !== 'composer' && layout !== 'composer_attachments' && layout !== 'composer_models' && layout !== 'full') throw new Error('气泡布局无效。')
    if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height) || height < 100 || height > 260)) throw new Error('气泡高度无效。')
    const nextHeight = (layout === 'composer' || layout === 'composer_attachments') && typeof height === 'number' ? Math.round(height) : undefined
    if (bubbleLayout === layout && compactBubbleHeight === nextHeight) return
    const size = stageBounds ?? { x: 0, y: 0, ...stageSize }
    const previous = bubbleRegion(bubbleLayout, size)
    bubbleLayout = layout
    compactBubbleHeight = nextHeight
    // 面板窗口的 bounds 就是当前布局的矩形，布局一变就得跟着改。
    syncPanelBounds()
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
  ipcMain.handle('pet:set-avatar-box', (event, box: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!box || typeof box !== 'object') return
    const { x, y, width, height } = box as Record<string, unknown>
    if (![x, y, width, height].every((value) => typeof value === 'number' && Number.isFinite(value))) return
    const bounds = avatarWindow?.getBounds()
    if (!bounds) return
    const left = Math.round(Math.max(0, Math.min(bounds.width, x as number)))
    const top = Math.round(Math.max(0, Math.min(bounds.height, y as number)))
    const boxWidth = Math.max(1, Math.min(bounds.width - left, Math.round(width as number)))
    const boxHeight = Math.max(1, Math.min(bounds.height - top, Math.round(height as number)))
    avatarBox = {
      right: bounds.width - left - boxWidth,
      bottom: bounds.height - top - boxHeight,
      width: boxWidth,
      height: boxHeight
    }
    applyPointerShape()
    // 姿势/大小变化后人物可见区会变，开着的余额卡跟着重新对齐。
    if (balanceOpen) syncBalancePosition()
  })
  ipcMain.handle('pet:set-panel-size', (event, width: unknown, height: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isFinite(width) || !Number.isFinite(height)) {
      throw new Error('面板尺寸无效。')
    }
    bubblePanelSize = {
      width: Math.round(Math.min(4000, Math.max(PANEL_MIN_WIDTH, width))),
      height: Math.round(Math.min(4000, Math.max(PANEL_MIN_HEIGHT, height)))
    }
    syncStageBounds()
    schedulePanelSizeSave()
  })
  ipcMain.handle('pet:set-plan-mode', async (event, on: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof on !== 'boolean') throw new Error('计划模式设置无效。')
    await activeController().setPlanMode(on)
  })
  ipcMain.handle('pet:set-approval-mode', async (event, mode: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!isApprovalMode(mode)) throw new Error('审批模式无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    await activeController().setApprovalMode(mode, conversationId as string | undefined)
  })
  ipcMain.handle('pet:answer-permission', async (event, id: unknown, allow: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string') throw new Error('操作编号无效。')
    if (typeof allow !== 'boolean') throw new Error('批准结果无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    await activeController().answerPermission(id, allow, conversationId as string | undefined)
  })
  ipcMain.handle('pet:set-effort', async (event, level: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!isEffortLevel(level)) throw new Error('思考强度无效。')
    await activeController().updateSettings({ effort: level })
  })
  ipcMain.handle('pet:set-web-search', async (event, on: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof on !== 'boolean') throw new Error('联网搜索设置无效。')
    await activeController().updateSettings({ webSearchEnabled: on })
  })
  ipcMain.handle('pet:set-auto-compact-percent', async (event, percent: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (!isAutoCompactPercent(percent)) throw new Error('自动压缩阈值应为 50–90 之间的整数。')
    await activeController().updateSettings({ autoCompactPercent: percent })
  })
  ipcMain.handle('pet:set-model-mode', (event, mode: unknown) => {
    if (!trusted(event)) return
    if (mode !== 'demo' && mode !== 'live' && mode !== 'claude_code') throw new Error('模型选项无效。')
    return activeController().setModelMode(mode)
  })
  ipcMain.handle('pet:set-avatar-state', (event, state: unknown) => {
    if (!trusted(event)) return
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
    if (!trusted(event)) return {}
    return {
      siliconFlowAvailable: Boolean(process.env.SILICONFLOW_API_KEY),
    }
  })
  ipcMain.handle('pet:transcribe-audio', async (event, request: unknown) => {
    voiceLog('[ipc] transcribe-audio called', { hasRequest: !!request, senderId: event.sender.id })
    if (!trusted(event)) throw new Error('无效的界面请求。')
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
    if (!trusted(event)) return
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
    const width = dragOrigin.bounds.width
    const height = dragOrigin.bounds.height
    const x = Math.round(dragOrigin.bounds.x + current.x - dragOrigin.cursor.x)
    const y = Math.round(dragOrigin.bounds.y + current.y - dragOrigin.cursor.y)
    // 头像窗口必须留在当前显示器的工作区内：一旦允许它掉到工作区下面，
    // 展开面板时舞台会被拉回工作区，人物就会“向上跳”，底部小三角也会
    // 被屏幕边缘削掉。坐标都是 DIP，系统缩放不同的显示器同样适用。
    const work = screen.getDisplayNearestPoint({ x: x + Math.round(width / 2), y: y + Math.round(height / 2) }).workArea
    // 右侧允许伸出窗口右缘的透明余量：人物能贴到屏幕右缘，本体不出屏。
    const RIGHT_SLACK = AVATAR_RIGHT_SLACK[currentAvatarSize] ?? 37
    const nextX = Math.min(Math.max(x, work.x), Math.max(work.x, work.x + work.width - width + RIGHT_SLACK))
    // 窗口底部允许伸出工作区，幅度正好等于人物脚底到窗口底的透明余量：
    // 人物可以拖到任务栏边缘，但角色本体不会出屏。余量随人物大小档变化。
    const BOTTOM_SLACK = AVATAR_BOTTOM_SLACK[currentAvatarSize] ?? 60
    const nextY = Math.min(Math.max(y, work.y), Math.max(work.y, work.y + work.height - height + BOTTOM_SLACK))
    avatarWindow.setBounds({
      x: nextX,
      y: nextY,
      width,
      height
    })
    syncBalancePosition()
  })
  ipcMain.handle('pet:end-drag', (event) => {
    if (trusted(event)) dragOrigin = undefined
  })
}

// 隔离冒烟测试：配合 DESKTOP_PET_WORKSPACE 指向临时目录时，允许再起一个实例。
const ownsSingleInstance = process.env.DESKTOP_PET_MULTI_INSTANCE === '1' || app.requestSingleInstanceLock()
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
  const initialSettings = (await activeController().getLibraryState()).settings
  memory.setEnabled(initialSettings.memoryEnabled)
  currentUiSize = initialSettings.uiSize
  currentAvatarSize = initialSettings.avatarSize
  const savedPanelSize = initialSettings.panelSize
  if (savedPanelSize) bubblePanelSize = { width: savedPanelSize.width, height: savedPanelSize.height }
  await memory.initialize()
  registerIpc()
  avatarWindow = createAvatarWindow()
  panelWindow = createPanelWindow()
  createTray()

  // First run with no model configured: let the pet appear first, then offer
  // the DeepSeek wizard. The marker file makes "later" a decision we remember.
  const onboardProfiles = (await activeController().getLibraryState()).settings.modelProfiles
  if (shouldOfferOnboarding(readOnboardingMarker(dataRoot), onboardProfiles.length,
    onboardProfiles.some((profile) => profile.needsKeyReentry))) {
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
