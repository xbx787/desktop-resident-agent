// 顶部条预览：渲染展开面板的 header，重点看缩放手柄的弧线、热区与菜单键。
//
//   npx electron scripts/header-preview.cjs   → .cache/header-preview.png
//
// 红色虚线框是缩放手柄热区（44×44，向左上伸出窗口，面板内有效 28×28）。
'use strict'
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const TOKENS = readFileSync(path.join(ROOT, 'src', 'renderer', 'design-tokens.css'), 'utf8')
const PANEL = readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.css'), 'utf8')

const MENU = '<svg viewBox="0 0 20 20"><path d="M3.5 5.5h13M3.5 10h13M3.5 14.5h9" /></svg>'
const EXPAND = '<svg viewBox="0 0 20 20"><path d="M8 4H4v4M12 4h4v4M16 12v4h-4M4 12v4h4" /></svg>'
const CLOSE = '<svg viewBox="0 0 20 20"><path d="m5 5 10 10M15 5 5 15" /></svg>'

const panel = () => `
<div class="panel-bubble is-expanded variant">
  <div class="panel-resize-grip"></div>
  <div class="hot"></div>
  <div class="panel-chat-header">
    <button type="button" class="panel-library-toggle">${MENU}</button>
    <nav class="panel-quick-tabs">
      <button type="button" class="panel-quick-tab is-current">会话一</button>
      <button type="button" class="panel-quick-tab">会话二</button>
      <button type="button" class="panel-quick-tab">会话三</button>
    </nav>
  </div>
  <button type="button" class="panel-expand-toggle panel-window-action">${EXPAND}</button>
  <button type="button" class="panel-window-close panel-window-action">${CLOSE}</button>
</div>`

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
${TOKENS}
${PANEL}
body { margin: 0; background: #0c1833; color: #cbd7ee; font-family: var(--font-ui); }
.harness { width: 460px; padding: 26px 20px 24px; }
.panel-bubble.variant { position: relative; right: auto; bottom: auto; width: 100%; height: 92px; }
/* 热区示意：44×44，左上各伸出面板 16px，面板内只剩 28×28。 */
.hot { position: absolute; left: -3px; top: -3px; width: 15px; height: 15px; border: 1px dashed rgba(255, 112, 122, .85); border-radius: 2px; pointer-events: none; }
.hot::after { content: '热区 15×15'; position: absolute; left: 38px; top: -16px; color: rgba(255, 150, 158, .9); font-size: 10px; white-space: nowrap; }
.caption { margin: 10px 0 0; color: #8fa6cf; font-size: 11px; line-height: 1.6; }
.caption b { color: #d8e4fa; font-weight: 600; }
.zoom { width: 300px; height: 160px; margin-top: 18px; overflow: hidden; border: 1px solid rgba(150, 180, 230, .25); border-radius: 10px; background: #0c1833; }
.zoom .panel-bubble.variant { width: 460px; transform: scale(2.4); transform-origin: top left; }
.zoom .hot::after { display: none; }
</style></head><body>
<div class="harness">
  <div class="preview">${panel()}</div>
  <p class="caption"><b>新布局</b>：弧线从窗口边内缩 3px，保留圆弧两端各约 6px 直线；热区缩到 15×15，面板内有效 12×12；菜单键左缘 12px，紧贴热区。</p>
  <div class="zoom">${panel()}</div>
  <p class="caption"><b>左上角放大 2.4×</b>：能看清弧线与面板圆角边之间的 3px 间隙，以及红框伸出窗口的部分。</p>
</div>
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1100, height: 820, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  win.webContents.setZoomFactor(2)
  await new Promise((resolve) => setTimeout(resolve, 900))
  mkdirSync(CACHE, { recursive: true })
  const shot = path.join(CACHE, 'header-preview.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('shot:', shot)
  app.quit()
}, (error) => { console.error(error); app.quit() })
