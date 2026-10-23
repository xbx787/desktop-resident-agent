import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
import { existsSync, mkdirSync, promises as fsp, readdirSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { AgentRuntime } from './agent-runtime'
import { SideChatController, activeSideChatParentId } from './side-chat'
import { isAskAnswers } from './ask-questions'
import { ConversationController, type LibraryLaunchResolver } from './conversation-controller'
import { MemoryService, type MemoryProvider } from './memory-service'
import { GrowthExperiments } from './growth-experiments'
import { ConversationStore, isModelProfile, MAX_BATCH_CONVERSATIONS } from './conversation-store'
import { electronSecretCodec, publicSettings, publicSnapshot, SecretProtectionUnavailableError } from './secret-storage'
import { linkClaudeUserResources } from './claude-resource-links'
import { CLAUDE_BASE_URL, DEFAULT_CLAUDE_MODEL, findClaudeExecutable, probeAnthropicEndpoint } from './claude-code'
import { seedClaudeMemory } from './claude-memory'
import { BUBBLE_BOTTOM, computeStageBounds, STAGE_HEIGHT, STAGE_WIDTH, TRIANGLE_ROOM } from './stage-bounds'
import { runSelfTest } from './self-test'
import { startInputActivity, stopInputActivity } from './input-activity'
import { EvolveStore } from './evolve-store'
import type { EvolveBridge } from './evolve-tools'
import { DshRuntime } from './dsh-runtime'
import { DshAgentClient } from './dsh-agent'
import { normalizeDshModel } from './dsh-model'
import { DshAcpRuntime, toAcpMcpServer, type DshAcpMcpServer } from './dsh-acp-runtime'
import { DshAcpAgentClient } from './dsh-acp-agent'
import { PetMcpBridge } from './pet-mcp-server'
import { deepSeekBaseUrl, deepSeekModel, deepSeekProfile, ONBOARDING_PAGES, readOnboardingMarker, shouldOfferOnboarding, writeOnboardingMarker, type OnboardingPage } from './onboarding'
import { normalizeApiKey } from '../shared/onboarding'
import { DeepSeekClient } from './deepseek'
import { fetchDeepSeekBalance } from './deepseek-balance'
import { transcribeAudio } from './asr-server'
import { voiceLog, voiceLogError } from './voice-log'
import { NoteStore } from './note-store'
import { createSnapshotScheduler } from './snapshot-scheduler'
import { getDeepSeekBalanceKey, getEnabledDeepSeekKey } from './model-config'
import { LibraryStore } from './library-store'
import { searchMarket } from './marketplace'
import { VoiceService } from './voice-service'
import { registerVoiceIpc } from './voice-ipc'
import { InboxWatcher } from './inbox-watcher'
import { isLibraryItem, isLibraryKind } from '../shared/libraries'
import { generateConversationTitle } from './title-generation'
import { APP_SLASH_COMMANDS, listClaudeWorkflows, parseAppSlashCommand } from './claude-workflows'
import { attachmentPreviewPath, prepareDroppedFile, readImagePreview, searchWorkspaceFiles, stagePastedAttachment, validAttachmentList, verifyDroppedFilePath } from './local-context'
import { findSourceProjectRoot, isUsableWorkspace, isWritableWorkspace, readSavedWorkspace, resolveAgentWorkspace, writeSavedWorkspace } from './workspace-root'
import { isEffortLevel } from '../shared/effort'
import type { AgentKernelKind, AvatarSize, BubbleLayout, ClaudeWorkflowOption, ConversationSettings, PanelDirection, PanelPlacement, UiSize, UserAttachment } from '../shared/contracts'
import { isAgentKernelKind, isApprovalMode, isAutoCompactPercent, isAvatarRenderer, PANEL_MIN_HEIGHT, PANEL_MIN_WIDTH } from '../shared/contracts'
import { isPersonaId } from '../shared/personas'
import { approvalAnchor, approvalCardHeight, approvalCardHtml, approvalCardWidth, approvalPointerLeft, placeApprovalCard, type ApprovalRect } from './approval-card'
import { probeProviderHealth } from './provider-health'
import { discoverProviderModels } from './model-discovery'
import { probeLibrary } from './library-health'

const projectRoot = app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '../..')
const dataProjectRoot = findSourceProjectRoot(projectRoot) ?? projectRoot
// 隔离冒烟测试/便携数据目录：显式指定时不再使用项目下的 data/。
const dataRootOverride = process.env.DESKTOP_PET_DATA?.trim()
const dataRoot = dataRootOverride && path.isAbsolute(dataRootOverride)
  ? dataRootOverride
  : path.join(dataProjectRoot, 'data')
const userHome = homedir()
const evolveStore = new EvolveStore(dataRoot)
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
/** Medium card (124) plus the requested 10px lower edge. All avatar sizes
 *  share this height so the type and buttons stay identical. */
const BALANCE_WINDOW_HEIGHT = 134
/** 人物图片的视觉重心比几何中心偏上，卡片跟着上提一点才看着齐。 */
const BALANCE_LIFT = 6
/** 三角尖到角色左缘的呼吸间距。 */
const BALANCE_GAP = 4
/** 渲染器上报的可见人物矩形，按右/下偏移保存——窗口缩放时命中形状跟着
 *  右下角走，不会在拖动过程中错位。 */
let avatarBox: { right: number; bottom: number; width: number; height: number } | undefined
let dragOrigin: { cursor: Electron.Point; bounds: Electron.Rectangle } | undefined
let avatarDragging = false
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
/** 面板相对人物的位置：用户选的，默认上方。不再按屏幕上下半自动翻。 */
let panelPlacement: PanelPlacement = 'top'
/** 上次发给面板窗口的位置；窗口重建时清空，保证会重发。 */
let sentPanelPlacement: PanelPlacement | undefined
/** 由 panelPlacement 派生：top/left/right 走“向上”布局，bottom 走“向下”。 */
let panelDirection: PanelDirection = 'up'

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

/** 状态点拱在人物可见矩形右上角之外；形状要把右上角一起圈进来，
 *  否则拖动后重算形状会把弧线裁成一条竖线。 */
function avatarShape(size: { width: number; height: number }): Electron.Rectangle[] {
  return [
    avatarRegion(size),
    { x: Math.max(0, size.width - 104), y: 0, width: Math.min(104, size.width), height: 96 }
  ]
}

/** 人物可见区的中心点（屏幕坐标）；渲染器还没上报时退回头像窗口中心。 */
function avatarFocusPoint(bounds: Electron.Rectangle): Electron.Point {
  const centerY = avatarBox
    ? bounds.y + (bounds.height - avatarBox.bottom - avatarBox.height) + avatarBox.height / 2
    : bounds.y + bounds.height / 2
  return { x: bounds.x + bounds.width - 88, y: Math.round(centerY) }
}

function bubbleRegion(layout: BubbleLayout, size: { width: number; height: number }, compactHeight = compactBubbleHeight, direction = panelDirection): Electron.Rectangle {
  // 向上时面板底边停在人物上方，小三角在窗口底部；向下时窗口顶边贴着人物
  // 底边，小三角在顶部。TRIANGLE_ROOM 始终含在面板窗口里。
  if (bubbleExpanded) {
    return direction === 'down'
      ? { x: 10, y: 0, width: size.width - 20, height: size.height }
      : { x: 10, y: 0, width: size.width - 20, height: size.height - BUBBLE_BOTTOM + TRIANGLE_ROOM }
  }
  if (direction === 'down') {
    switch (layout) {
      case 'empty': return { x: size.width - 120, y: 0, width: 64, height: 56 + TRIANGLE_ROOM }
      case 'composer':
      case 'composer_attachments': {
        const height = compactHeight ?? (layout === 'composer' ? 206 : 232)
        return { x: size.width - 342, y: 0, width: 332, height: height + TRIANGLE_ROOM }
      }
      case 'composer_models': return { x: size.width - 342, y: 0, width: 332, height: 238 + TRIANGLE_ROOM }
      case 'full': return { x: size.width - 366, y: 0, width: 356, height: 358 + TRIANGLE_ROOM }
    }
  }
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
  win.setShape(avatarShape(win.getBounds()))
}

/** 面板窗口只包住面板矩形（逻辑舞台里的 bubbleRegion）。左/右贴边时直接
 *  相对头像窗口定位，不再走“舞台”的上下布局。 */
function syncPanelBounds(): void {
  const stage = stageBounds
  const panel = panelWindow
  if (!stage || !panel || panel.isDestroyed()) return
  const region = bubbleRegion(bubbleLayout, stage, compactBubbleHeight, panelDirection)
  let target = { x: stage.x + region.x, y: stage.y + region.y, width: region.width, height: region.height }
  if ((panelPlacement === 'left' || panelPlacement === 'right') && avatarWindow && !avatarWindow.isDestroyed()) {
    const avatar = avatarWindow.getBounds()
    const gap = 10
    const x = panelPlacement === 'left' ? avatar.x - region.width - gap : avatar.x + avatar.width + gap
    const y = avatar.y + avatar.height - region.height
    const work = screen.getDisplayNearestPoint({ x: avatar.x, y: avatar.y }).workArea
    target = {
      x: Math.min(work.x + work.width - region.width - 4, Math.max(work.x + 4, x)),
      y: Math.min(work.y + work.height - region.height - 4, Math.max(work.y + 4, y)),
      width: region.width,
      height: region.height
    }
  }
  broadcastPanelPlacement()
  const current = panel.getBounds()
  if (current.x === target.x && current.y === target.y && current.width === target.width && current.height === target.height) {
    syncGripWindow()
    return
  }
  panel.setBounds(target, false)
  syncGripWindow()
}

/** 左上角缩放手柄的独立置顶小窗：面板窗口不置顶，抓手要一直在最上面。
 *  抓手的拖动事件由这个小窗发给主进程，尺寸在这里算，面板实时跟随。 */
const GRIP_SIZE = 44
let gripWindow: BrowserWindow | undefined
let gripDrag: { startX: number; startY: number; width: number; height: number; targetWidth: number; targetHeight: number; right: number; bottom: number; top: number } | undefined

function ensureGripWindow(): BrowserWindow {
  if (gripWindow && !gripWindow.isDestroyed()) return gripWindow
  const win = new BrowserWindow({
    width: GRIP_SIZE,
    height: GRIP_SIZE,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden;cursor:nwse-resize}
    .grip{position:absolute;inset:3px;border:2px solid rgba(190,214,255,.62);border-radius:15px;clip-path:inset(0 17px 17px 0);filter:drop-shadow(0 0 3px rgba(160,205,255,.5))}
    .grip:hover{border-color:rgba(225,242,255,.95);filter:drop-shadow(0 0 6px rgba(160,205,255,.9))}
  </style></head><body><div class="grip"></div><script>
    const { ipcRenderer } = require('electron')
    let dragging = false
    addEventListener('pointerdown', (event) => { if (event.button !== 0) return; dragging = true; ipcRenderer.send('pet:grip-resize', { phase: 'start', x: event.screenX, y: event.screenY }) })
    addEventListener('pointermove', (event) => { if (!dragging) return; ipcRenderer.send('pet:grip-resize', { phase: 'move', x: event.screenX, y: event.screenY }) })
    addEventListener('pointerup', (event) => { if (!dragging) return; dragging = false; ipcRenderer.send('pet:grip-resize', { phase: 'end', x: event.screenX, y: event.screenY }) })
  <\/script></body></html>`
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  gripWindow = win
  return win
}

function syncGripWindow(): void {
  const panel = panelWindow
  if (!panel || panel.isDestroyed() || !panel.isVisible() || !bubbleExpanded) {
    gripWindow?.hide()
    return
  }
  const bounds = panel.getBounds()
  const win = ensureGripWindow()
  const y = panelDirection === 'down' ? bounds.y + bounds.height - GRIP_SIZE : bounds.y
  const current = win.getBounds()
  if (current.x !== bounds.x || current.y !== y) {
    win.setBounds({ x: bounds.x, y, width: GRIP_SIZE, height: GRIP_SIZE }, false)
  }
  if (!win.isVisible()) win.showInactive()
  // 手柄永远压在角色/面板之上；同层窗口靠 moveTop 抢最前。
  win.moveTop()
}

/** 告诉面板窗口它贴在人物的哪一侧，小三角据此换方向。 */
function broadcastPanelPlacement(): void {
  const panel = panelWindow
  if (!panel || panel.isDestroyed()) return
  if (sentPanelPlacement === panelPlacement) return
  sentPanelPlacement = panelPlacement
  panel.webContents.send('pet:panel-placement', panelPlacement)
}

/** 余额卡与人物可见区域对齐：顶部与人物顶部齐平，右侧三角尖离角色左缘
 *  4px，高度统一为中等卡片再向下延伸 10px。优先用渲染器上报的真实命中框
 *  （高 12px 是按压/呼吸缓冲，减掉才是可见高度）。 */
function balanceBoundsFor(bounds: Electron.Rectangle): Electron.Rectangle {
  const width = BALANCE_CARD_WIDTH + BALANCE_POINTER
  let roleLeft: number
  let roleTop: number
  if (avatarBox) {
    roleLeft = bounds.x + (bounds.width - avatarBox.right - avatarBox.width)
    roleTop = bounds.y + (bounds.height - avatarBox.bottom - avatarBox.height) + 6
  } else {
    const visible = AVATAR_VISIBLE_BOX[currentAvatarSize] ?? AVATAR_VISIBLE_BOX.small
    roleLeft = bounds.x + bounds.width - 88 - visible.width / 2
    roleTop = bounds.y + visible.top
  }
  return {
    x: Math.round(roleLeft - BALANCE_GAP - width),
    y: Math.round(roleTop + BALANCE_INSET_Y / 2 - BALANCE_LIFT),
    width,
    height: BALANCE_WINDOW_HEIGHT
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
  const focus = avatarFocusPoint(avatar)
  const work = screen.getDisplayNearestPoint(focus).workArea
  const direction: PanelDirection = panelPlacement === 'bottom' ? 'down' : 'up'
  if (direction !== panelDirection) {
    panelDirection = direction
    panelWindow?.webContents.send('pet:panel-direction', direction)
  }
  const next = computeStageBounds(
    direction === 'down'
      // 向下展开时面板顶边要贴角色可见底边，而不是窗口底边；角色图下方的
      // 透明边会让面板看起来离人物很远。
      ? { ...avatar, height: Math.max(0, avatar.height - (avatarBox?.bottom ?? 0)) }
      : avatar,
    work, bubbleExpanded, bubbleExpanded ? bubblePanelSize : undefined, direction)
  // 头像窗口绝对不动：向上时舞台底边、向下时舞台顶边贴着头像底边，尺寸取
  // 布局计算值。展开/收起只改变面板窗口，人物在屏幕上的位置保持不变。
  stageBounds = {
    x: avatar.x + avatar.width - next.width,
    y: direction === 'down' ? next.y : bottom - next.height,
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
const libraryStore = new LibraryStore(dataRoot, { homeDir: userHome, workspace: agentWorkspace })
const voiceService = new VoiceService({
  dataRoot,
  codec: electronSecretCodec(),
  onJobProgress: (progress) => {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.webContents.send('pet:voice:job-progress', progress)
    }
  }
})

function libraryServerName(id: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) hash = Math.imul(hash ^ id.charCodeAt(index), 0x01000193)
  const slug = id.replace(/[^a-zA-Z0-9_-]+/gu, '_').replace(/^_+|_+$/gu, '').slice(0, 40)
  return `lib_${slug || 'entry'}_${(hash >>> 0).toString(36)}`
}

/** Turns `kind:id` keys into the engine's MCP map and plugin directories.
 *  Only installed entries survive, so a removed library simply disappears. */
const resolveLibraries: LibraryLaunchResolver = async (keys) => {
  const { mcp, plugins } = await libraryStore.launches(keys)
  const resolved: string[] = []
  const servers: Record<string, unknown> = {}
  for (const item of mcp) {
    const launch = item.launch
    if (!launch) continue
    if (!launch.url && !launch.command) continue
    resolved.push(`mcp:${item.id}`)
    servers[libraryServerName(item.id)] = launch.url
      ? { type: 'http', url: launch.url }
      : {
          type: 'stdio',
          command: launch.command,
          args: launch.args ?? [],
          // Claude inherits PATH and the environment; DSH's MCP bridge scrubs
          // names matching KEY/PASSWORD/SECRET/TOKEN, so pass the declared
          // values explicitly from the main process environment.
          env: Object.fromEntries((launch.env ?? [])
            .map((name) => [name, process.env[name] ?? ''] as const)
            .filter(([, value]) => Boolean(value)))
        }
  }
  const pluginPaths: string[] = []
  for (const item of plugins) {
    if (!item.path) continue
    resolved.push(`${item.kind}:${item.id}`)
    pluginPaths.push(item.path)
  }
  return { resolved, mcp: servers, plugins: pluginPaths }
}
let controller: ConversationController | undefined
/** Set when a restart is queued; consumed after the running turns are saved. */
let relaunchOnQuit = false
/** Polls until every conversation is idle, then relaunches. */
let restartPoll: NodeJS.Timeout | undefined
const memory = new MemoryService(dataRoot, { onError: (error) => console.warn(error.message) })

/** 独立看门狗：旧进程退出后，如果目标 exe 没在跑，就由它把新版本拉起来。 */
function spawnRestartWatchdog(targetExe: string): void {
  try {
    const script = path.join(dataRoot, 'restart-watchdog.ps1')
    const log = path.join(dataRoot, 'restart-watchdog.log')
    writeFileSync(script, [
      'param([string]$TargetExe,[int]$OldPid,[string]$Log)',
      'function L($m){ "$(Get-Date -Format o) $m" | Add-Content -LiteralPath $Log }',
      'L "watchdog old=$OldPid target=$TargetExe"',
      'for($i=0;$i -lt 90;$i++){ if(-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)){ break }; Start-Sleep -Milliseconds 500 }',
      'Start-Sleep -Milliseconds 800',
      'if(Test-Path -LiteralPath $TargetExe){',
      '  $running = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $TargetExe }',
      '  if(-not $running){ Start-Process -FilePath $TargetExe -WorkingDirectory (Split-Path $TargetExe); L "started" } else { L "already running" }',
      '} else { L "missing $TargetExe" }'
    ].join('\r\n'), 'utf8')
    spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
      '-TargetExe', targetExe, '-OldPid', String(process.pid), '-Log', log],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch (error) {
    console.error('Restart watchdog failed:', error)
  }
}

type RestartOutcome = 'restarted' | 'waiting' | 'cancelled'

/** 重启请示一次只开一张卡：重复请求复用同一次答复，避免叠两张勾叉。 */
let restartApproval: Promise<boolean | null> | undefined

function askRestartApproval(): Promise<boolean | null> {
  restartApproval ??= requestApproval(
    '还有任务在跑，现在就重启吗？',
    '点勾：立刻退出重启，正在跑的任务会被打断；点叉：这次不重启，等你说下一步。'
  ).finally(() => { restartApproval = undefined })
  return restartApproval
}

/** 别的任务还在跑就要用户点头：勾=现在就走，叉=取消这次重启。
 *  只有请求者自己的回合在跑时不算“别人”，照旧等它跑完再重启。 */
async function decideRestart(excludeConversationId?: string): Promise<'now' | 'wait' | 'cancel'> {
  const otherBusy = (controller?.hasRunningWorkExcept(excludeConversationId) ?? false) || sideChat.isBusy()
  if (!otherBusy) return 'wait'
  return (await askRestartApproval()) === true ? 'now' : 'cancel'
}

/** 关闭前给人物一个告别表情：只等一小会儿，绝不拖住退出。 */
function playAvatarFarewell(): Promise<void> {
  const win = avatarWindow && !avatarWindow.isDestroyed() ? avatarWindow : null
  if (!win) return Promise.resolve()
  try {
    win.webContents.send('pet:avatar:farewell')
  } catch {
    return Promise.resolve()
  }
  return new Promise((resolve) => setTimeout(resolve, 700))
}

/** 退出并拉起指定 exe：快捷方式先切，看门狗兜底。 */
async function restartNow(executable: string): Promise<void> {
  await playAvatarFarewell()
  pointShortcutsAt(executable)
  spawnRestartWatchdog(executable)
  relaunchOnQuit = true
  app.quit()
}

/** Restarts without cutting a running turn. 有别人的任务在跑时先弹勾叉：
 *  勾=立刻重启（打断它们），叉=取消并等用户下一条消息。 */
async function requestRestart(excludeConversationId?: string, beforeQuit?: () => void): Promise<RestartOutcome> {
  const decision = await decideRestart(excludeConversationId)
  if (decision === 'cancel') return 'cancelled'
  beforeQuit?.()
  if (decision === 'now' || (controller?.allConversationsIdle() ?? true)) {
    await restartNow(process.execPath)
    return 'restarted'
  }
  if (!restartPoll) {
    restartPoll = setInterval(() => {
      if (controller && !controller.allConversationsIdle()) return
      if (restartPoll) clearInterval(restartPoll)
      restartPoll = undefined
      void restartNow(process.execPath)
    }, 1000)
    restartPoll.unref?.()
  }
  return 'waiting'
}

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

/** Tools for the selfEvolve tier. Scheduling and status are cheap; restart is
 *  deferred until the running turn is idle so the current answer is saved. */
function evolveHooksFor(conversationId: string): Omit<EvolveBridge, 'enabled'> {
  return {
    schedule: async (input) => {
      const task = evolveStore.schedule(conversationId, input)
      return {
        taskId: task.id,
        goal: task.goalCondition ?? null,
        pending: task.steps.filter((step) => step.status === 'pending')
          .map((step) => ({ id: step.id, kind: step.kind, text: step.text.slice(0, 300) })),
        restartCount: task.restartCount
      }
    },
    status: async () => {
      const task = evolveStore.load()
      if (!task || task.conversationId !== conversationId) return { active: false }
      return {
        active: task.status === 'active',
        status: task.status,
        goal: task.goalCondition ?? null,
        note: task.note ?? null,
        restartCount: task.restartCount,
        steps: task.steps.map((step) => ({
          id: step.id, kind: step.kind, status: step.status,
          text: step.text.slice(0, 300), result: step.result?.slice(0, 1_000)
        }))
      }
    },
    restart: async (version) => {
      let task = evolveStore.load()
      if (!task || task.conversationId !== conversationId) {
        // 目标模式下没有安排跨重启步骤也能重启：把当前目标写进任务，
        // 重启后 resumeEvolveTask 会重新装上目标并继续。
        const currentGoal = controller?.getSnapshot().goal?.condition
        if (!currentGoal) throw new Error('还没有安排跨重启任务；先调用 schedule。')
        task = evolveStore.schedule(conversationId, { goal: currentGoal })
      }
      if (task.status !== 'active') throw new Error('当前自我进化任务不在进行中。')
      if (!task.goalCondition) {
        const currentGoal = controller?.getSnapshot().goal?.condition
        if (currentGoal) task = evolveStore.schedule(conversationId, { goal: currentGoal })
      }
      if (!evolveStore.hasPending() && !task.goalCondition) throw new Error('没有待继续的目标或步骤，重启会直接结束任务。')
      // 次数只在用户同意之后才记：点叉取消的重启不该消耗额度。
      const noteRestart = (): void => {
        if (!evolveStore.noteRestart()) throw new Error('重启次数达到上限，任务已停止。')
      }
      if (version) {
        const executable = path.join(dataProjectRoot, 'release', `whale-companion-v${version}`, 'win-unpacked', 'Whale Companion Preview.exe')
        if (!existsSync(executable)) throw new Error(`找不到版本 ${version} 的安装目录。`)
        const outcome = await restartWhenIdle(version, conversationId, noteRestart)
        if (outcome === 'cancelled') {
          return { scheduled: false, cancelled: true, note: '用户点了叉：这次不重启，正在跑的任务继续。停下手上的事，等用户下一条消息。' }
        }
        return { scheduled: true, waiting: outcome === 'waiting', version }
      }
      const outcome = await requestRestart(conversationId, noteRestart)
      if (outcome === 'cancelled') {
        return { scheduled: false, cancelled: true, note: '用户点了叉：这次不重启，正在跑的任务继续。停下手上的事，等用户下一条消息。' }
      }
      return { scheduled: true, waiting: outcome === 'waiting' }
    }
  }
}

// Gray-switch the kernel through DESKTOP_PET_KERNEL=dsh. DSH is a vendored
// pnpm runtime; npm's flat tree resolves the tool scheduler to the wrong copy,
// which turns every tool call into TOOL_OUTCOME_UNKNOWN.
const dshBin = (() => {
  const override = process.env.DESKTOP_PET_DSH_BIN?.trim()
  const candidates = [
    override,
    app.isPackaged ? path.join(process.resourcesPath, 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js') : '',
    path.join(projectRoot, 'reference', 'dsh-poc-pnpm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  ].filter((value): value is string => Boolean(value))
  return candidates.find((value) => existsSync(value)) ?? null
})()
// DSH is the only agent kernel. `claude_code` remains a stored conversation
// mode for old records, but no Claude runtime is loaded or packaged.
const useDshKernel = (): boolean => Boolean(dshBin)

const mcpBridgeScript = (() => {
  const override = process.env.DESKTOP_PET_MCP_BRIDGE?.trim()
  const candidates = [
    override,
    app.isPackaged ? path.join(process.resourcesPath, 'pet-mcp-bridge.cjs') : '',
    path.join(projectRoot, 'scripts', 'pet-mcp-bridge.cjs')
  ].filter((value): value is string => Boolean(value))
  return candidates.find((value) => existsSync(value)) ?? null
})()

// The CLI alone decides whether the SDK path exists; the key may arrive later
// from a saved model profile instead of the launch environment.
// One runtime (and one engine connection) per conversation that actually
// runs; the controller creates them on demand through this factory.
const createRuntime = (conversationId: string, onChange: () => void, persistSession = true, enableEvolve = true): AgentRuntime => {
  const key = claudeKey ?? apiKey ?? ''
  const dshModel = useDshKernel() && dshBin
    ? (() => {
      const bridge = new PetMcpBridge(key)
      // 打包/重启这类请示走角色旁的小批准卡，绿勾批准、红叉拒绝。
      bridge.setApprovalBridge({ request: (title, detail) => requestApproval(title, detail) })
      // 用 adapter 目录里的模型 id：deepseek-flash 声明了图片输入，deepseek-v4-flash 不在目录里，会被读图工具判定为不支持图片。
      const model = normalizeDshModel(process.env.DSH_MODEL)
      if (process.env.DESKTOP_PET_DSH_TRANSPORT === 'sdk-minimal') {
        return new DshAgentClient({
          bridge,
          runtime: new DshRuntime({
            bin: dshBin,
            home: path.join(dataRoot, 'dsh-home'),
            cwd: agentWorkspace,
            provider: 'deepseek-official',
            model,
            env: { DEEPSEEK_API_KEY: key },
            mcpBridge: mcpBridgeScript
              ? { script: mcpBridgeScript, endpoint: () => bridge.endpoint }
              : undefined
          }),
          cwd: agentWorkspace
        })
      }
      const dshHome = path.join(dataRoot, 'dsh-home')
      const dshLibraries: { mcp: Record<string, unknown>; plugins: string[] } = { mcp: {}, plugins: [] }
      return new DshAcpAgentClient({
        bridge,
        cwd: agentWorkspace,
        provider: 'deepseek-official',
        model,
        deepseekApiKey: key,
        dshHome,
        libraries: dshLibraries,
        runtime: new DshAcpRuntime({
          bin: dshBin,
          home: dshHome,
          cwd: agentWorkspace,
          systemPrompt: 'You are XiaoJing, a helpful desktop companion. Reply in the user language.',
          env: { DEEPSEEK_API_KEY: key },
          mcpServers: () => {
            const servers: DshAcpMcpServer[] = []
            const endpoint = bridge.endpoint
            if (mcpBridgeScript && endpoint) {
              servers.push({
                name: 'pet',
                command: process.execPath,
                args: [mcpBridgeScript],
                env: [
                  { name: 'ELECTRON_RUN_AS_NODE', value: '1' },
                  { name: 'PET_BRIDGE_URL', value: endpoint.url },
                  { name: 'PET_BRIDGE_TOKEN', value: endpoint.token },
                  // 联网搜索关闭时桥不声明搜索/抓取工具。
                  { name: 'PET_MCP_WEB', value: bridge.webSearchEnabled ? '1' : '0' }
                ]
              })
            }
            for (const [name, raw] of Object.entries(dshLibraries.mcp)) {
              const server = toAcpMcpServer(name, raw)
              if (server) servers.push(server)
            }
            return servers
          }
        })
      })
    })()
    : undefined
  return new AgentRuntime(
    new NoteStore(projectRoot),
    apiKey ? new DeepSeekClient(apiKey) : undefined,
    onChange,
    dshModel,
    agentWorkspace,
    enableEvolve ? evolveHooksFor(conversationId) : undefined
  )
}
controller = new ConversationController(
  new ConversationStore(dataRoot, electronSecretCodec()),
  createRuntime,
  () => publishSnapshot(),
  (error) => { console.error('Conversation background task failed:', error) },
  claudeKey || apiKey
    ? (source, locale, model) => generateConversationTitle((claudeKey || apiKey)!, source, AbortSignal.timeout(20_000), locale, model)
    : undefined,
  // The launch environment, materialized as the first editable profile.
  claudeKey
    ? { id: 'default', name: 'DeepSeek', baseUrl: CLAUDE_BASE_URL, apiKey: claudeKey,
        model: DEFAULT_CLAUDE_MODEL, smallModel: 'deepseek-flash' }
    : undefined,
  resolveLibraries
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
  (sessionId, onChange, persistSession) => createRuntime(sessionId, onChange, persistSession, false),
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
  if (!isWritableWorkspace(next)) throw new Error('工作目录不可写，请选择有写权限的文件夹。')
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
  libraryStore.setWorkspace(normalized)
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
  if (process.platform === 'win32') win.setShape(avatarShape({ width, height }))
  // 人物永远在最上层：连其他置顶窗口（面板、播放器）也不能把她盖住。
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.on('show', () => win.setAlwaysOnTop(true, 'screen-saver'))
  win.once('ready-to-show', () => {
    win.show()
    win.moveTop()
  })
  win.on('move', () => {
    // 拖动的是头像窗口；逻辑舞台跟着它平移，面板窗口再跟着舞台走。
    // 越过屏幕中线时改由 syncStageBounds 重算展开方向。
    const bounds = win.getBounds()
    if (stageBounds) {
      stageBounds = {
        ...stageBounds,
        x: bounds.x - (stageBounds.width - bounds.width),
        y: panelDirection === 'down'
          ? bounds.y + bounds.height
          : bounds.y - (stageBounds.height - bounds.height)
      }
    }
    syncPanelBounds()
    syncBalancePosition()
    if (gripWindow && !gripWindow.isDestroyed() && gripWindow.isVisible()) gripWindow.moveTop()
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

/** 拖动缩放手柄时的全局悬浮手柄：独立置顶小窗，拖出面板也看得见。 */
const RESIZE_GHOST_SIZE = 240
let resizeGhostWindow: BrowserWindow | undefined

function resizeGhostAt(pos: { x: number; y: number } | null): void {
  if (pos === null) {
    resizeGhostWindow?.hide()
    return
  }
  if (!resizeGhostWindow || resizeGhostWindow.isDestroyed()) {
    const win = new BrowserWindow({
      width: RESIZE_GHOST_SIZE,
      height: RESIZE_GHOST_SIZE,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      show: false,
      webPreferences: { sandbox: false }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setIgnoreMouseEvents(true)
    const html = '<!doctype html><html><body style="margin:0;overflow:hidden;background:transparent">'
      + '<svg width="240" height="240" viewBox="0 0 240 240" style="position:absolute;inset:0;overflow:visible">'
      + '<path d="M135 105 L120 105 A15 15 0 0 0 105 120 L105 135" fill="none" stroke="rgba(80,160,255,.22)" stroke-width="36" stroke-linecap="round" filter="blur(9px)"/>'
      + '<path d="M135 105 L120 105 A15 15 0 0 0 105 120 L105 135" fill="none" stroke="rgba(90,180,255,.4)" stroke-width="22" stroke-linecap="round" filter="blur(5px)"/>'
      + '<path d="M135 105 L120 105 A15 15 0 0 0 105 120 L105 135" fill="none" stroke="rgba(150,220,255,.65)" stroke-width="11" stroke-linecap="round" filter="blur(2px)"/>'
      + '<path d="M135 105 L120 105 A15 15 0 0 0 105 120 L105 135" fill="none" stroke="#e8f9ff" stroke-width="2.6" stroke-linecap="round"/></svg></body></html>'
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    resizeGhostWindow = win
  }
  resizeGhostWindow.setBounds({
    // 圆弧的 45° 点（圆心 48,48，半径 22）对准鼠标。
    x: Math.round(pos.x - (120 - 15 / Math.SQRT2)),
    y: Math.round(pos.y - (120 - 15 / Math.SQRT2)),
    width: RESIZE_GHOST_SIZE,
    height: RESIZE_GHOST_SIZE
  }, false)
  if (!resizeGhostWindow.isVisible()) resizeGhostWindow.showInactive()
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
    // 消息窗口不置顶：可以被其他应用盖住；角色窗口才保持最上层。
    alwaysOnTop: false,
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
  sentPanelPlacement = undefined
  // 面板右键：复制选中的消息文本；输入框里额外提供剪切/粘贴；全选始终可用。
  win.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate([
      { role: 'copy', label: '复制', enabled: params.selectionText.length > 0 || params.editFlags.canCopy },
      { role: 'cut', label: '剪切', enabled: params.isEditable && params.editFlags.canCut },
      { role: 'paste', label: '粘贴', enabled: params.isEditable && params.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: '全选' }
    ])
    menu.popup({ window: win })
  })
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
    height: 620,
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

/** Runs one cross-restart command in the agent workspace. Output is clipped so
 *  a chatty build cannot blow up the task file or the conversation. */
function runEvolveCommand(command: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      // Self-evolution commands are mostly build/package steps, so the project
      // root is the useful default; absolute paths still address the workspace.
      cwd: dataProjectRoot,
      timeout: 10 * 60_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim()
      resolve({ ok: !error, output: (output || (error ? error.message : '')).slice(-8_000) })
    })
  })
}

/** Picks up an active self-evolution task after a restart: re-selects the
 *  conversation, restores the approval tier, runs queued commands, re-arms the
 *  goal, and sends the pending prompt. Failure marks the task instead of
 *  looping forever. */
async function resumeEvolveTask(): Promise<void> {
  const task = evolveStore.load()
  if (!task || task.status !== 'active') return
  // 手动启动不自动续跑：只有计划重启（noteRestart 置位）才继续。
  if (!task.resumePending) {
    evolveStore.setStatus('paused', '应用是手动启动的，目标未自动续跑。')
    return
  }
  evolveStore.markResumed()
  if (!task || task.status !== 'active') return
  const id = task.conversationId
  try {
    const record = await controller?.selectConversation(id)
    if (!record) throw new Error('找不到要恢复的对话。')
    if (record.mode !== 'claude_code') throw new Error('对话不在 Claude Code 模式，无法恢复。')
    await controller?.setApprovalMode('selfEvolve', id).catch(() => undefined)

    const notes: string[] = []
    for (const step of task.steps.filter((item) => item.kind === 'command' && item.status === 'pending')) {
      evolveStore.updateStep(step.id, { status: 'running' })
      const result = await runEvolveCommand(step.text)
      evolveStore.updateStep(step.id, { status: result.ok ? 'done' : 'failed', result: result.output })
      notes.push(`跨重启命令${result.ok ? '完成' : '失败'}：${step.text}\n${result.output}`)
      if (!result.ok) {
        evolveStore.setStatus('failed', `跨重启命令失败：${result.output.slice(0, 300)}`)
        break
      }
    }

    const refreshed = evolveStore.load()
    if (!refreshed || refreshed.status !== 'active') return
    if (refreshed.goalCondition) {
      await controller?.sendMessage(`/goal ${refreshed.goalCondition}`, [], 'queue', id)
    }
    const next = refreshed.steps.find((item) => item.kind === 'prompt' && item.status === 'pending')
    if (next) evolveStore.updateStep(next.id, { status: 'done' })
    if (notes.length || next || refreshed.goalCondition) {
      // 详细上下文仍走隐藏系统消息，避免把旧轮和新轮搅在一起；
      // 真正开新轮的是用户消息「继续执行目标」，它带新头像、分隔上下两段。
      const details: string[] = []
      if (notes.length) details.push(notes.join('\n\n'))
      if (refreshed.goalCondition) details.push(`目标条件：${refreshed.goalCondition}`)
      if (next) details.push(`下一步：${next.text}`)
      const version = app.getVersion()
      const lastEntry = controller?.getSnapshot().timeline.at(-1)
      const alreadyContinued = lastEntry?.kind === 'user' && /^(?:已重启，)?继续执行目标/u.test(lastEntry.text)
      if (!alreadyContinued) {
        // 一条隐藏上下文的用户条目：界面只画分割线，模型拿到命令结果和下一步。
        const prompt = ['已重启，继续执行目标', `（应用已按计划重启到 ${version}，继续上次的任务。）`, ...details]
          .join('\n\n').slice(0, 8_000)
        await controller?.sendMessage(prompt, [], 'queue', id, true)
      }
    } else {
      evolveStore.setStatus('done', '没有待继续的步骤。')
    }
  } catch (error) {
    evolveStore.setStatus('failed', error instanceof Error ? error.message : String(error))
  }
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
    syncStageBounds()
    applyPointerShape()
    // 面板是独立窗口：要真正激活它，输入框才能拿到键盘。
    if (panelWindow && !panelWindow.isDestroyed()) {
      panelWindow.show()
      panelWindow.focus()
      syncGripWindow()
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

/** 隐藏人物和聊天窗口，只留通知区域图标；左击图标再把人物叫回来。 */
function hideAvatar(): void {
  if (balanceOpen) setBalanceOpen(false)
  hidePanel()
  avatarWindow?.hide()
}

/** 打包/重启这类请示的小卡：绿勾批准、红叉拒绝，点一下回传。 */
interface PendingApproval {
  resolve: (approved: boolean | null) => void
  timer: NodeJS.Timeout
}
const pendingApprovals = new Map<string, PendingApproval>()

/** 打包/重启这类请示的小卡：只用来批准或拒绝。
 *
 *  卡片按内容取自然宽度，标题和待批准内容完整显示，按钮固定在底部；
 *  位置锚定当前会话标签（例如“开发1”）的正下方，而不是面板窗口最下沿。
 *  标签位置由渲染进程量出来，主进程只负责把它换算成屏幕坐标。 */
function activeTabRect(win: BrowserWindow): Promise<ApprovalRect | null> {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.panel-quick-tab.is-current');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`).then((value: unknown) => {
    if (!value || typeof value !== 'object') return null
    const rect = value as Record<string, unknown>
    const numbers = [rect.x, rect.y, rect.width, rect.height].map((item) => Number(item))
    if (!numbers.every((item) => Number.isFinite(item)) || numbers[2] <= 0 || numbers[3] <= 0) return null
    return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
  }).catch(() => null)
}

/** 标签按钮测不到时（面板刚切换/头部重绘），退回面板头部下沿；
 *  绝不退到整个面板窗口的底边。 */
function panelHeaderRect(win: BrowserWindow): Promise<ApprovalRect | null> {
  return win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.panel-chat-header');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  })()`).then((value: unknown) => {
    if (!value || typeof value !== 'object') return null
    const rect = value as Record<string, unknown>
    const numbers = [rect.x, rect.y, rect.width, rect.height].map((item) => Number(item))
    if (!numbers.every((item) => Number.isFinite(item)) || numbers[2] <= 0 || numbers[3] <= 0) return null
    return { x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3] }
  }).catch(() => null)
}

function requestApproval(title: string, detail?: string, timeoutMs = 5 * 60_000): Promise<boolean | null> {
  const cardTitle = title.trim() || '需要你的批准'
  const cardDetail = (detail ?? '').trim()
  const cardWidth = approvalCardWidth(cardTitle, cardDetail)
  const cardHeight = approvalCardHeight(cardTitle, cardDetail, cardWidth)
  const html = approvalCardHtml(cardTitle, cardDetail, cardWidth)
  return new Promise((resolve) => {
    // 批准时把余额框收起来：同一位置只留批准/拒绝。
    if (balanceOpen) setBalanceOpen(false)
    const win = new BrowserWindow({
      // 左右各留 8px 给卡片阴影，不然阴影会被窗口边缘切掉。
      width: cardWidth + 16,
      // 先给足高度让正文按最终宽度排版，量完实际高度再缩到内容大小。
      height: Math.max(cardHeight, 480),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: true,
      show: false,
      webPreferences: { sandbox: true }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    let settled = false
    const finish = (value: boolean | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), timeoutMs)
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url.includes('/approve')) finish(true)
      else if (url.includes('/reject')) finish(false)
    })
    win.on('closed', () => finish(null))
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    win.webContents.once('did-finish-load', () => {
      void (async () => {
        if (win.isDestroyed()) return
        const panel = panelWindow && !panelWindow.isDestroyed() && panelWindow.isVisible() ? panelWindow.getBounds() : null
        const avatar = avatarWindow && !avatarWindow.isDestroyed() ? avatarWindow.getBounds() : null
        const work = screen.getDisplayMatching(panel ?? avatar ?? screen.getPrimaryDisplay().workArea).workArea
        let anchor: ApprovalRect | null = null
        // 优先挂当前会话标签：多标签时“开发1”的卡就落在“开发1”下面。
        if (panel && panelWindow && !panelWindow.isDestroyed()) {
          const tab = await activeTabRect(panelWindow)
          // 标签按钮暂时测不到时贴面板头部下沿；不能用 panel.height 退到窗口底边。
          const header = tab ? null : await panelHeaderRect(panelWindow)
          anchor = approvalAnchor(panel, tab, header)
        }
        if (!anchor) {
          const balance = avatar ? balanceBoundsFor(avatar) : null
          anchor = balance
            ? { x: balance.x + balance.width - 44, y: balance.y, width: 0, height: 0 }
            : { x: work.x + Math.round((work.width - cardWidth) / 2), y: work.y + 24, width: 0, height: 0 }
        }
        const size = { width: cardWidth + 16, height: cardHeight }
        // 估算只用于开窗；内容渲染完后按实际高度再定一次，避免正文被窗口裁掉。
        const measured = await win.webContents.executeJavaScript(`(() => {
          const r = document.querySelector('.card')?.getBoundingClientRect();
          return r ? { height: Math.ceil(r.height) } : null;
        })()`).catch(() => null) as { height?: number } | null
        if (measured?.height && Number.isFinite(measured.height)) {
          size.height = Math.min(490, Math.max(96, measured.height + 18))
        }
        const position = placeApprovalCard(anchor, size, work)
        const above = position.y < anchor.y
        win.setBounds({ ...position, ...size }, false)
        // 卡片被工作区夹住时指针仍指向标签中心；翻到标签上方时三角朝下。
        const pointer = approvalPointerLeft(anchor, { x: position.x + 8, width: cardWidth })
        await win.webContents.executeJavaScript(`(() => {
          document.documentElement.style.setProperty('--pointer-left', '${pointer}px');
          document.body.classList.toggle('is-above', ${above});
          const card = document.querySelector('.card');
          if (card) card.classList.toggle('is-above', ${above});
        })()`).catch(() => undefined)
        if (win.isDestroyed()) return
        win.show()
        win.moveTop()
        win.focus()
      })()
    })
  })
}

/** 启动/切换模型后探测一次供应商地址。ConnectionRefused 时明确告诉用户
 *  是本地代理没起来，并给一个“切换到官方地址”的按钮；用户选“暂不”后同一
 *  地址不再反复弹。 */
let providerCheckInFlight: Promise<void> | undefined
let dismissedProviderBaseUrl = ''
function checkProviderHealth(): Promise<void> {
  providerCheckInFlight ??= (async () => {
    if (process.argv.includes('--self-test')) return
    const settings = (await activeController().getLibraryState()).settings
    const profile = settings.modelProfiles.find((item) => item.id === settings.activeModelProfileId)
    if (!profile?.baseUrl) return
    const health = await probeProviderHealth(profile.baseUrl)
    if (health.ok || !health.localProxy) {
      if (health.ok) dismissedProviderBaseUrl = ''
      return
    }
    if (dismissedProviderBaseUrl === profile.baseUrl) return
    const options = {
      type: 'warning' as const,
      title: '模型地址无法连接',
      message: health.message,
      detail: '本地代理没有运行时，DSH 请求会直接 ConnectionRefused。启动代理后重试，或现在切到 DeepSeek 官方 Anthropic 兼容地址。',
      buttons: ['切换到官方地址', '暂不切换'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    }
    const parent = panelWindow && !panelWindow.isDestroyed() ? panelWindow : undefined
    const result = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options)
    if (result.response !== 0) {
      dismissedProviderBaseUrl = profile.baseUrl
      return
    }
    try {
      await activeController().useOfficialEndpoint()
      dismissedProviderBaseUrl = ''
    } catch (error) {
      dialog.showErrorBox('切换官方地址失败', error instanceof Error ? error.message : String(error))
    }
  })().catch((error: unknown) => {
    console.warn('Provider health check unavailable:', error instanceof Error ? error.message : String(error))
  }).finally(() => {
    providerCheckInFlight = undefined
  })
  return providerCheckInFlight
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
    { label: '隐藏', click: hideAvatar },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ])
  tray = new Tray(icon)
  tray.setToolTip('小鲸')
  tray.setContextMenu(contextMenu)
  tray.on('click', () => {
    // 隐藏后左击图标只把人物叫回来，不顺手弹开聊天气泡；人物可见时仍
    // 按原来的行为打开/聚焦面板。
    if (avatarWindow && !avatarWindow.isVisible()) {
      avatarWindow.show()
      avatarWindow.moveTop()
      return
    }
    avatarWindow?.show()
    showPanel()
  })
  // Windows 11 默认把新图标收进任务栏溢出区；晚一点再把它标记为常驻显示。
  setTimeout(promoteTrayIcon, 1_500)
  setTimeout(promoteTrayIcon, 4_000)
}

/** 把本程序的托盘图标标记为常驻，避免默认被收进任务栏的折叠区。 */
function promoteTrayIcon(): void {
  if (process.platform !== 'win32') return
  const exe = process.execPath.toLowerCase()
  const reg = (args: string[]): Promise<string> => new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout))
  })
  void (async () => {
    const listing = await reg(['query', 'HKCU\\Control Panel\\NotifyIconSettings', '/s'])
    if (!listing) return
    let current = ''
    const matches: string[] = []
    for (const line of listing.split(/\r?\n/u)) {
      const key = /^(HKEY_CURRENT_USER\\[^\r\n]+)$/u.exec(line.trim())
      if (key) {
        current = key[1]
        continue
      }
      const pathValue = /^\s+ExecutablePath\s+REG_\w+\s+(.+)$/u.exec(line)
      if (pathValue && pathValue[1].trim().toLowerCase() === exe) matches.push(current)
    }
    for (const key of matches) {
      await reg(['add', key, '/v', 'IsPromoted', '/t', 'REG_DWORD', '/d', '1', '/f'])
    }
  })()
}

function hidePanel(): void {
  if (!panelOpen) return
  panelOpen = false
  panelWindow?.hide()
  syncGripWindow()
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
  const editable = ['visibleConversationTabs', 'autoArchiveAfterDays', 'effort', 'goalMaxIterations', 'goalMaxMinutes', 'memoryEnabled', 'uiSize', 'avatarSize', 'avatarRenderer', 'toolRowDetail', 'webSearchEnabled', 'personaId', 'agentKernel', 'autoCompactPercent', 'assistantAvatar', 'enableAutoTitleGeneration', 'showMessageTimestamps', 'userName', 'assistantName', 'panelPlacement', 'panelTheme',
    'outputStyle', 'appendSystemPrompt', 'autoScroll', 'expandFileEditsByDefault', 'sessionSort', 'titleLocale', 'titleModel', 'loadUserSettings']
  if (Object.keys(input).some((key) => !editable.includes(key))) throw new Error('会话设置无效。')
  const patch: Partial<ConversationSettings> = {}
  if (input.agentKernel !== undefined) {
    if (!isAgentKernelKind(input.agentKernel)) throw new Error('Agent 内核设置无效。')
    patch.agentKernel = input.agentKernel
  }
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
  if (input.avatarRenderer !== undefined) {
    if (!isAvatarRenderer(input.avatarRenderer)) throw new Error('人物渲染方式无效。')
    patch.avatarRenderer = input.avatarRenderer
  }
  if (input.panelPlacement !== undefined) {
    if (input.panelPlacement !== 'top' && input.panelPlacement !== 'bottom' &&
        input.panelPlacement !== 'left' && input.panelPlacement !== 'right') {
      throw new Error('面板位置设置无效。')
    }
    patch.panelPlacement = input.panelPlacement
  }
  if (input.panelTheme !== undefined) {
    if (input.panelTheme !== 'dark' && input.panelTheme !== 'light') throw new Error('面板主题设置无效。')
    patch.panelTheme = input.panelTheme
  }
  if (input.toolRowDetail !== undefined) {
    if (input.toolRowDetail !== 'full' && input.toolRowDetail !== 'brief' && input.toolRowDetail !== 'name') {
      throw new Error('工具行详细程度无效。')
    }
    patch.toolRowDetail = input.toolRowDetail
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
  if (input.outputStyle !== undefined) {
    if (typeof input.outputStyle !== 'string' || input.outputStyle.length > 64) throw new Error('回答风格无效。')
    patch.outputStyle = input.outputStyle
  }
  if (input.appendSystemPrompt !== undefined) {
    if (typeof input.appendSystemPrompt !== 'string' || input.appendSystemPrompt.length > 4_000) throw new Error('附加指令不能超过 4000 字。')
    patch.appendSystemPrompt = input.appendSystemPrompt
  }
  for (const key of ['autoScroll', 'expandFileEditsByDefault'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') throw new Error('显示设置无效。')
    patch[key] = input[key]
  }
  if (input.sessionSort !== undefined) {
    if (input.sessionSort !== 'updated' && input.sessionSort !== 'created') throw new Error('会话排序设置无效。')
    patch.sessionSort = input.sessionSort
  }
  if (input.titleLocale !== undefined) {
    if (input.titleLocale !== 'auto' && input.titleLocale !== 'zh' && input.titleLocale !== 'en') throw new Error('标题语言设置无效。')
    patch.titleLocale = input.titleLocale
  }
  if (input.titleModel !== undefined) {
    if (typeof input.titleModel !== 'string' || input.titleModel.length > 64) throw new Error('标题模型设置无效。')
    patch.titleModel = input.titleModel
  }
  if (input.loadUserSettings !== undefined) {
    if (typeof input.loadUserSettings !== 'boolean') throw new Error('用户设置加载开关无效。')
    patch.loadUserSettings = input.loadUserSettings
  }
  return patch
}

/** 解析真正可用的发布 exe：优先指定版本，否则退回最新的可用版本。 */
function resolveLaunchTarget(version?: string): string {
  const releaseRoot = path.join(dataProjectRoot, 'release')
  if (version) {
    const preferred = path.join(releaseRoot, `whale-companion-v${version}`, 'win-unpacked', 'Whale Companion Preview.exe')
    if (existsSync(preferred)) return preferred
  }
  try {
    const candidates = readdirSync(releaseRoot)
      .filter((name) => /^whale-companion-v\d+\.\d+\.\d+$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .reverse()
      .map((name) => path.join(releaseRoot, name, 'win-unpacked', 'Whale Companion Preview.exe'))
      .filter((file) => existsSync(file))
    if (candidates[0]) return candidates[0]
  } catch {
    // release 目录不可读时退回当前进程。
  }
  return process.execPath
}

/** 把项目根和桌面的小鲸快捷方式指到指定 exe；目标不存在时绝不写入。 */
function pointShortcutsAt(executable: string): void {
  if (process.platform !== 'win32' || !app.isPackaged || !existsSync(executable)) return
  const targets = [path.join(dataProjectRoot, '小鲸.lnk')]
  try {
    targets.push(path.join(app.getPath('desktop'), '小鲸.lnk'))
  } catch {
    // 没有桌面目录时只处理项目根。
  }
  for (const shortcut of targets) {
    try {
      const ok = shell.writeShortcutLink(shortcut, 'create', {
        target: executable,
        cwd: path.dirname(executable),
        description: '小鲸',
        icon: executable,
        iconIndex: 0
      })
      if (!ok) console.error('Shortcut switch returned false:', shortcut)
    } catch (error) {
      console.error('Shortcut switch failed:', shortcut, error)
    }
  }
}

let adoptedRestartTimer: NodeJS.Timeout | undefined

/** 切到指定版本并退出；告别动作播完再走。 */
async function adoptVersion(executable: string): Promise<void> {
  await playAvatarFarewell()
  pointShortcutsAt(executable)
  spawnRestartWatchdog(executable)
  app.relaunch({ execPath: executable })
  app.quit()
}

async function restartWhenIdle(version: string, excludeConversationId?: string, beforeQuit?: () => void): Promise<RestartOutcome> {
  if (adoptedRestartTimer) clearInterval(adoptedRestartTimer)
  const executable = resolveLaunchTarget(version)
  const decision = await decideRestart(excludeConversationId)
  if (decision === 'cancel') return 'cancelled'
  beforeQuit?.()
  if (decision === 'now' || (controller?.allConversationsIdle() ?? true)) {
    await adoptVersion(executable)
    return 'restarted'
  }
  const startedAt = Date.now()
  adoptedRestartTimer = setInterval(() => {
    // 等对话空闲，但最多等 2 分钟：旧实例里可能有永远不结束的回合，
    // 不能让版本切换无限期卡住（表现就是一直停在旧版本）。
    if (!controller?.allConversationsIdle() && Date.now() - startedAt < 120_000) return
    if (adoptedRestartTimer) clearInterval(adoptedRestartTimer)
    adoptedRestartTimer = undefined
    void fsp.access(executable)
      .then(() => adoptVersion(executable))
      .catch((error: unknown) => console.error('Adopted version restart failed:', error))
  }, 1500)
  adoptedRestartTimer.unref?.()
  return 'waiting'
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
  // Growth experiments are a local development tool. The packaged build has
  // no tab for them and rejects their channels too.
  const growthTrusted = (event: Electron.IpcMainInvokeEvent): boolean => !app.isPackaged && settingsTrusted(event)
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
      // 面板贴哪一侧改了：立刻按新位置重排，不必等下一次打开。
      const nextPlacement = settings.panelPlacement ?? 'top'
      if (nextPlacement !== panelPlacement) {
        panelPlacement = nextPlacement
        syncStageBounds()
      }
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
  ipcMain.handle('pet:settings:capabilities', (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return activeController().getCapabilities()
  })
  ipcMain.handle('pet:settings:close', (event) => {
    if (!settingsTrusted(event)) return
    settingsWindow?.close()
  })
  ipcMain.handle('pet:settings:quit', (event) => {
    if (!settingsTrusted(event)) return
    app.quit()
  })
  ipcMain.handle('pet:settings:restart', async (event) => {
    if (!settingsTrusted(event)) return false
    return (await requestRestart()) === 'waiting'
  })
  ipcMain.handle('pet:libraries:list', async (event) => {
    if (!settingsTrusted(event)) throw new Error('无效的界面请求。')
    return libraryStore.snapshot()
  })
  ipcMain.handle('pet:libraries:installed', async (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    return libraryStore.list()
  })
  ipcMain.handle('pet:libraries:search', async (event, kind: unknown, query: unknown) => {
    if (!settingsTrusted(event) || !isLibraryKind(kind)) throw new Error('市场请求无效。')
    if (typeof query !== 'string') throw new Error('搜索词无效。')
    const settings = (await activeController().getLibraryState()).settings
    return searchMarket(kind, query, settings.skillMarketSources)
  })
  ipcMain.handle('pet:libraries:install', async (event, raw: unknown) => {
    if (!settingsTrusted(event) || !isLibraryItem(raw)) throw new Error('库条目无效。')
    await libraryStore.install(raw)
    return libraryStore.snapshot()
  })
  ipcMain.handle('pet:libraries:remove', async (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('库条目无效。')
    await libraryStore.remove(id)
    return libraryStore.snapshot()
  })
  ipcMain.handle('pet:libraries:set-enabled', async (event, id: unknown, enabled: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('库条目无效。')
    await libraryStore.setEnabled(id, enabled)
    return libraryStore.snapshot()
  })
  ipcMain.handle('pet:libraries:health', async (event, id: unknown) => {
    if (!settingsTrusted(event) || typeof id !== 'string') throw new Error('库条目无效。')
    const item = (await libraryStore.list()).find((entry) => entry.id === id)
    if (!item) throw new Error('找不到这个库条目。')
    return probeLibrary(item)
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
    if (!growthTrusted(event)) throw new Error('成长模式仅在开发版可用。')
    return { ...await growth.availability(), proposals: await growth.list() }
  })
  ipcMain.handle('pet:growth:propose', (event, title: unknown, objective: unknown, evidence: unknown) => {
    if (!growthTrusted(event) || typeof title !== 'string' || typeof objective !== 'string' || typeof evidence !== 'string') throw new Error('改进提案无效。')
    return growth.propose(title, objective, evidence)
  })
  ipcMain.handle('pet:growth:experiment', (event, id: unknown) => {
    if (!growthTrusted(event) || typeof id !== 'string') throw new Error('实验编号无效。')
    return growth.experiment(id)
  })
  ipcMain.handle('pet:growth:update-notes', (event, id: unknown, notes: unknown) => {
    if (!growthTrusted(event) || typeof id !== 'string' || typeof notes !== 'string') throw new Error('版本说明无效。')
    return growth.updateReleaseNotes(id, notes)
  })
  ipcMain.handle('pet:growth:adopt', async (event, id: unknown) => {
    if (!growthTrusted(event) || typeof id !== 'string') throw new Error('采纳请求无效。')
    if (!activeController().allConversationsIdle() || sideChat.isBusy()) throw new Error('请等其他会话和临时会话完成或停止后再采纳。')
    const adopted = await growth.adopt(id)
    if (adopted.version) restartWhenIdle(adopted.version)
    return adopted
  })
  ipcMain.handle('pet:growth:publish', (event, id: unknown) => {
    if (!growthTrusted(event) || typeof id !== 'string') throw new Error('发布请求无效。')
    return growth.publish(id)
  })
  ipcMain.handle('pet:growth:discard', (event, id: unknown) => {
    if (!growthTrusted(event) || typeof id !== 'string') throw new Error('丢弃请求无效。')
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
  ipcMain.handle('pet:export-conversation', async (event, id: unknown) => {
    if (!trusted(event) || typeof id !== 'string') throw new Error('会话编号无效。')
    const payload = await activeController().exportConversation(id)
    const safe = payload.conversation.title.replace(/[\\/:*?"<>|]/gu, '-').trim().slice(0, 60) || 'conversation'
    const options: Electron.SaveDialogOptions = {
      title: '导出会话',
      defaultPath: `${safe}.dsh.json`,
      filters: [{ name: 'DSH 会话', extensions: ['json'] }]
    }
    const parent = panelWindow && !panelWindow.isDestroyed() ? panelWindow : undefined
    const result = parent ? await dialog.showSaveDialog(parent, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    await fsp.writeFile(result.filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    return result.filePath
  })
  ipcMain.handle('pet:import-conversation', async (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    const options: Electron.OpenDialogOptions = {
      title: '导入会话',
      properties: ['openFile'],
      filters: [{ name: 'DSH 会话', extensions: ['json'] }]
    }
    const parent = panelWindow && !panelWindow.isDestroyed() ? panelWindow : undefined
    const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
    const file = result.canceled ? undefined : result.filePaths[0]
    if (!file) return null
    const stat = await fsp.stat(file)
    if (stat.size > 64 * 1024 * 1024) throw new Error('会话文件超过 64 MB，无法导入。')
    const parsed: unknown = JSON.parse(await fsp.readFile(file, 'utf8'))
    return activeController().importConversation(parsed)
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
  ipcMain.handle('pet:background-task', (event, toolUseId: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof toolUseId !== 'string' || !toolUseId) throw new Error('子代理编号无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().backgroundTask(toolUseId, conversationId as string | undefined)
  })
  ipcMain.handle('pet:stop-task', (event, taskId: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof taskId !== 'string' || !taskId) throw new Error('子代理编号无效。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().stopTask(taskId, conversationId as string | undefined)
  })
  ipcMain.handle('pet:message-subagent', (event, toolUseId: unknown, text: unknown, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof toolUseId !== 'string' || !toolUseId) throw new Error('子代理编号无效。')
    if (typeof text !== 'string' || !text.trim()) throw new Error('消息不能为空。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().messageSubagent(toolUseId, text, conversationId as string | undefined)
  })
  ipcMain.handle('pet:resume-queue', (event, conversationId: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (conversationId !== undefined && typeof conversationId !== 'string') throw new Error('会话编号无效。')
    return activeController().resumeQueue(conversationId as string | undefined)
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
  ipcMain.handle('pet:set-model-profile-enabled', (event, id: unknown, enabled: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (typeof id !== 'string' || typeof enabled !== 'boolean') throw new Error('模型配置格式无效。')
    return activeController().setModelProfileEnabled(id, enabled)
  })
  ipcMain.handle('pet:discover-models', async (event, profile: unknown) => {
    if (!modelTrusted(event)) throw new Error('无效的界面请求。')
    if (!isModelProfile(profile)) throw new Error('模型配置格式无效。')
    const saved = (await activeController().getLibraryState()).settings.modelProfiles.find((item) => item.id === profile.id)
    const apiKey = profile.apiKey || (saved?.baseUrl === profile.baseUrl ? saved.apiKey : '')
    if (!apiKey) throw new Error('请先输入 API Key。')
    return discoverProviderModels({ baseUrl: profile.baseUrl, apiKey })
  })
  ipcMain.handle('pet:set-model-profile', async (event, id: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (id !== null && typeof id !== 'string') throw new Error('模型配置编号无效。')
    const result = await activeController().setModelProfile(id)
    // 切换后异步探测，不拖慢按钮；不可达时再弹明确提示。
    void checkProviderHealth()
    return result
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
  ipcMain.handle('pet:get-panel-placement', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    syncStageBounds()
    return panelPlacement
  })
  ipcMain.handle('pet:get-panel-direction', (event) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    syncStageBounds()
    return panelDirection
  })
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
  ipcMain.handle('pet:open-path', async (event, value: unknown) => {
    if (!trusted(event)) throw new Error('无效的界面请求。')
    if (typeof value !== 'string' || value.length > 2_000 || !path.isAbsolute(value)) throw new Error('文件路径无效。')
    const target = path.resolve(value)
    // Image results may point at the original file the tool read, wherever it
    // lives. Restrict the hand-off to image extensions rather than a folder.
    if (!/\.(png|jpe?g|gif|webp)$/i.test(target)) throw new Error('只能打开图片文件。')
    if (!existsSync(target)) throw new Error('文件已经不存在。')
    const failure = await shell.openPath(target)
    if (failure) throw new Error(`无法打开原图：${failure}`)
  })
  ipcMain.handle('pet:set-bubble-layout', (event, layout: unknown, height: unknown) => {
    if (!trusted(event)) return
    if (layout !== 'empty' && layout !== 'composer' && layout !== 'composer_attachments' && layout !== 'composer_models' && layout !== 'full') throw new Error('气泡布局无效。')
    if (height !== undefined && (typeof height !== 'number' || !Number.isFinite(height) || height < 100 || height > 260)) throw new Error('气泡高度无效。')
    const nextHeight = (layout === 'composer' || layout === 'composer_attachments') && typeof height === 'number' ? Math.round(height) : undefined
    if (bubbleLayout === layout && compactBubbleHeight === nextHeight) return
    const size = stageBounds ?? { x: 0, y: 0, ...stageSize }
    const previous = bubbleRegion(bubbleLayout, size, compactBubbleHeight, panelDirection)
    bubbleLayout = layout
    compactBubbleHeight = nextHeight
    // 面板窗口的 bounds 就是当前布局的矩形，布局一变就得跟着改。
    syncPanelBounds()
    if (shapeShrinkTimer) clearTimeout(shapeShrinkTimer)
    shapeShrinkTimer = undefined
    const next = bubbleRegion(layout, size, nextHeight, panelDirection)
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
    // 姿势/大小变化会移动人物可见区的中心，展开方向和命中形状都跟着重算；
    // 余额卡也在 syncStageBounds 里重新对齐。
    syncStageBounds()
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
  ipcMain.on('pet:resize-ghost', (event, pos: unknown) => {
    if (!trusted(event)) return
    if (pos === null) {
      resizeGhostAt(null)
      return
    }
    const point = pos && typeof pos === 'object' ? pos as { x?: unknown; y?: unknown } : null
    if (point && typeof point.x === 'number' && typeof point.y === 'number' &&
      Number.isFinite(point.x) && Number.isFinite(point.y)) {
      resizeGhostAt({ x: point.x, y: point.y })
    }
  })
  ipcMain.on('pet:grip-resize', (event, payload: unknown) => {
    const panel = panelWindow
    if (!panel || panel.isDestroyed() || !bubbleExpanded) return
    // 只接受抓手小窗自己的消息，别的页面不能改面板尺寸。
    if (!gripWindow || event.sender !== gripWindow.webContents) return
    const value = payload && typeof payload === 'object' ? payload as { phase?: unknown; x?: unknown; y?: unknown } : null
    if (!value || typeof value.x !== 'number' || typeof value.y !== 'number' ||
        !Number.isFinite(value.x) || !Number.isFinite(value.y)) return
    if (value.phase === 'start') {
      const bounds = panel.getBounds()
      gripDrag = {
        startX: value.x, startY: value.y,
        width: bounds.width, height: bounds.height,
        targetWidth: bounds.width, targetHeight: bounds.height,
        right: bounds.x + bounds.width, bottom: bounds.y + bounds.height, top: bounds.y
      }
      resizeGhostAt({ x: value.x, y: value.y })
      return
    }
    if (!gripDrag) return
    if (value.phase === 'move') {
      const dx = value.x - gripDrag.startX
      const dy = value.y - gripDrag.startY
      gripDrag.targetWidth = Math.round(Math.min(4000, Math.max(PANEL_MIN_WIDTH, gripDrag.width - dx)))
      gripDrag.targetHeight = Math.round(Math.min(4000, Math.max(PANEL_MIN_HEIGHT, panelDirection === 'down'
        ? gripDrag.height + dy
        : gripDrag.height - dy)))
      // 和面板里的抓手一致：拖动时只给悬浮手柄，松手再一次性应用尺寸。
      resizeGhostAt({ x: value.x, y: value.y })
      return
    }
    if (value.phase === 'end') {
      resizeGhostAt(null)
      bubblePanelSize = { width: gripDrag.targetWidth, height: gripDrag.targetHeight }
      gripDrag = undefined
      syncStageBounds()
      schedulePanelSizeSave()
    }
  })
  ipcMain.on('pet:approval-result', (event, id: unknown, approved: unknown) => {
    if (!trusted(event)) return
    if (typeof id !== 'string') return
    const pending = pendingApprovals.get(id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingApprovals.delete(id)
    pending.resolve(approved === true)
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
  registerVoiceIpc({
    ipcMain,
    service: voiceService,
    trusted,
    settingsTrusted,
    broadcastConfig: async () => {
      const config = await voiceService.getVoiceConfig()
      for (const win of [avatarWindow, panelWindow]) {
        if (win && !win.isDestroyed()) win.webContents.send('pet:voice-config-changed', config)
      }
    },
    sendJobProgress: (progress) => {
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('pet:voice:job-progress', progress)
      }
    },
    pickDocument: async () => {
      if (!settingsWindow) throw new Error('设置窗口不可用。')
      const result = await dialog.showOpenDialog(settingsWindow, {
        title: '选择要转成音频的文档',
        properties: ['openFile'],
        filters: [{ name: '文档', extensions: ['md', 'txt'] }]
      })
      const filePath = result.filePaths[0]
      if (result.canceled || !filePath) return null
      const info = await fsp.stat(filePath)
      if (!info.isFile()) throw new Error('请选择一个文档文件。')
      return { path: filePath, name: path.basename(filePath), size: info.size }
    },
    openExternal: async (url) => { await shell.openExternal(url) },
    openPath: async (target) => {
      await fsp.mkdir(target, { recursive: true }).catch(() => undefined)
      const error = await shell.openPath(target)
      if (error) throw new Error('无法打开目录。')
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
    if ((event.sender.id !== avatarWindow?.webContents.id && event.sender.id !== panelWindow?.webContents.id) || !avatarWindow || !isScreenPoint(cursor)) return
    dragOrigin = { cursor, bounds: avatarWindow.getBounds() }
    avatarDragging = true
  })
  ipcMain.handle('pet:drag-move', (event, current: unknown) => {
    if ((event.sender.id !== avatarWindow?.webContents.id && event.sender.id !== panelWindow?.webContents.id) || !avatarWindow || !dragOrigin || !isScreenPoint(current)) return
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
    if (trusted(event)) {
      dragOrigin = undefined
      avatarDragging = false
      syncStageBounds()
    }
  })
}

// 隔离冒烟测试：配合 DESKTOP_PET_WORKSPACE 指向临时目录时，允许再起一个实例。
const ownsSingleInstance = process.env.DESKTOP_PET_MULTI_INSTANCE === '1' || app.requestSingleInstanceLock()
if (!ownsSingleInstance) {
  // Do not disappear silently: a second copy looks like a crash otherwise.
  void app.whenReady().then(async () => {
    try {
      await dialog.showMessageBox({
        type: 'info',
        title: '小鲸已在运行',
        message: '已经有一个小鲸实例在运行。请先从托盘退出旧实例，再启动新版本。'
      })
    } finally {
      app.quit()
    }
  })
} else app.on('second-instance', (_event, commandLine) => {
  // Lets the packaging script close a running copy without killing it.
  if (commandLine.includes('--quit')) {
    app.quit()
    return
  }
  // One-command restart for the evolve loop: wait for idle, then relaunch.
  if (commandLine.includes('--restart')) {
    void requestRestart()
    return
  }
  avatarWindow?.show()
  showPanel()
})

if (ownsSingleInstance) void app.whenReady().then(async () => {
  // Scripts can ask a fresh copy to close right away; without this the flag
  // would only work when another instance already holds the single-instance lock.
  if (process.argv.includes('--quit')) {
    app.quit()
    return
  }
  await linkClaudeUserResources(path.join(dataRoot, 'claude'), userHome).catch((error: unknown) => {
    console.warn('Claude user resource links unavailable:', error instanceof Error ? error.message : String(error))
  })
  await activeController().initialize()
  inboxWatcher = new InboxWatcher(path.join(dataRoot, 'inbox'), activeController())
  inboxWatcher.start()
  const initialSettings = (await activeController().getLibraryState()).settings
  memory.setEnabled(initialSettings.memoryEnabled)
  currentUiSize = initialSettings.uiSize
  currentAvatarSize = initialSettings.avatarSize
  panelPlacement = initialSettings.panelPlacement ?? 'top'
  panelDirection = panelPlacement === 'bottom' ? 'down' : 'up'
  const savedPanelSize = initialSettings.panelSize
  if (savedPanelSize) bubblePanelSize = { width: savedPanelSize.width, height: savedPanelSize.height }
  await memory.initialize()
  registerIpc()
  // 启动即自愈：快捷方式必须指向当前正在运行的版本，目录被换掉也不会指空。
  pointShortcutsAt(process.execPath)
  // 预加载缩放手柄悬浮窗，避免按下时因首次创建/加载出现空档。
  resizeGhostAt({ x: -2000, y: -2000 })
  resizeGhostAt(null)
  avatarWindow = createAvatarWindow()
  panelWindow = createPanelWindow()
  createTray()
  // 全局键鼠活动：面板提示框里实时显示按键与鼠标三键。
  startInputActivity((activity) => {
    for (const win of [panelWindow, avatarWindow]) {
      if (win && !win.isDestroyed()) win.webContents.send('pet:input-activity', activity)
    }
  })
  // 启动探测放在窗口出现之后，弹提示时才有正确的父窗口；自检模式不打扰。
  if (!process.argv.includes('--self-test')) setTimeout(() => { void checkProviderHealth() }, 3_000)

  // First run with no model configured: let the pet appear first, then offer
  // the DeepSeek wizard. The marker file makes "later" a decision we remember.
  const onboardProfiles = (await activeController().getLibraryState()).settings.modelProfiles
  if (shouldOfferOnboarding(readOnboardingMarker(dataRoot), onboardProfiles.length,
    onboardProfiles.some((profile) => profile.needsKeyReentry))) {
    setTimeout(openOnboarding, 1000)
  }

  // 自我进化：上一次运行留下了跨重启任务时，等窗口和运行时就绪后继续。
  // 自检模式不恢复，避免干扰打包验证。
  if (!process.argv.includes('--self-test')) {
    setTimeout(() => { void resumeEvolveTask() }, 2_000)
  }

  // 启动自检：打包脚本用 --self-test 启动新版本，结果落到 data/self-test，
  // 不弹额外窗口、不改用户设置；--self-test-exit 时跑完就退出。
  if (process.argv.includes('--self-test')) {
    setTimeout(() => {
      void (async () => {
        const settingsReady = await activeController().getLibraryState().then(() => true).catch(() => false)
        const result = runSelfTest({
          version: app.getVersion(),
          dataRoot,
          rendererRoot: path.join(__dirname, '../renderer'),
          windowsReady: Boolean(avatarWindow && !avatarWindow.isDestroyed() && avatarWindow.isVisible() &&
            panelWindow && !panelWindow.isDestroyed()),
          settingsReady
        })
        console.log(`Self-test ${result.ok ? 'passed' : 'failed'} (${result.version})`)
        if (process.argv.includes('--self-test-exit')) app.quit()
      })()
    }, 3_000)
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

let quitting = false
let inboxWatcher: InboxWatcher | undefined
app.on('before-quit', (event) => {
  stopInputActivity()
  if (quitting) return
  quitting = true
  // Hold the quit until the running turn has been written. A turn normally
  // saves when it finishes; quitting mid-turn used to drop everything since
  // the last save, which looked like the last work block disappearing.
  event.preventDefault()
  inboxWatcher?.stop()
  inboxWatcher = undefined
  controller?.stopAll(true)
  voiceService.dispose()
  void sideChat.discardAll()
  if (balanceWindow && !balanceWindow.isDestroyed()) balanceWindow.destroy()
  balanceWindow = undefined
  tray?.destroy()
  tray = undefined
  void Promise.race([
    controller?.flushAll() ?? Promise.resolve(),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000))
  ]).catch((error: unknown) => {
    console.error('Final conversation save failed:', error)
  }).finally(async () => {
    await controller?.disposeAll().catch(() => undefined)
    if (relaunchOnQuit) app.relaunch()
    app.quit()
  })
})

// The tray owns the app lifecycle. Closing one window (or a startup window
// failing to open) must not take down the resident process; only an explicit
// tray/menu quit or a failed startup does that.
app.on('window-all-closed', () => {
  if (!tray) app.quit()
})


