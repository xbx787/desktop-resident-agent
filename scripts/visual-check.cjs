// 视觉自查：把真实的 panel/avatar 样式注入一段仿真 DOM（消息轮、竖线、结算行、
// 工具图标），在真实 Electron 窗口里渲染并截图。改几何、改图标之后先跑这个，
// 看一眼再交出去。
//
//   npx electron scripts/visual-check.cjs   → .cache/visual-check.png
'use strict'
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const CSS = [
  readFileSync(path.join(ROOT, 'src', 'renderer', 'panel.css'), 'utf8'),
  readFileSync(path.join(ROOT, 'src', 'renderer', 'avatar.css'), 'utf8')
].join('\n')

// 手抄自 src/renderer/tool-icons.tsx——改了那边记得同步这里，否则截图看的是旧图形。
const ICONS = {
  terminal: '<path d="m7.6 5.2-3.6 4.8 3.6 4.8" /><path d="m12.4 5.2 3.6 4.8-3.6 4.8" />',
  pencil: '<path d="m4.6 14.8.6-2.9 7.6-7.6 2.4 2.4-7.6 7.6z" /><path d="m11.6 5.6 2.4 2.4" />',
  document: '<path d="M6.2 3.6h4.6l3.4 3.4v9.4H6.2z" /><path d="M10.8 3.6v3.4h3.4" />',
  search: '<circle cx="9.2" cy="9.2" r="4.4" /><path d="m12.6 12.6 3.2 3.2" />',
  gear: '<circle cx="10" cy="10" r="2.6" /><path d="M10 3.4v2M10 14.6v2M3.4 10h2M14.6 10h2M5.3 5.3l1.4 1.4M13.3 13.3l1.4 1.4M14.7 5.3l-1.4 1.4M6.7 13.3l-1.4 1.4" />'
}

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
${CSS}
body { margin: 0; background: #0d1b3a; font-family: "Microsoft YaHei UI", sans-serif; }
.harness { width: 560px; padding: 16px 18px 20px; }
.row { display: flex; align-items: center; gap: 14px; margin-top: 26px; }
.row .panel-tool-icon { stroke: #a9c6f7; }
.two { display: flex; gap: 34px; }
.big .panel-tool-icon { width: 64px; height: 64px; stroke-width: 1; }
.tiny .panel-tool-icon { width: 16px; height: 16px; }
</style></head><body>
<div class="harness">
  <div class="panel-turn">
    <article class="panel-event panel-event-user">
      <div class="panel-event-avatar"><span class="panel-event-glyph">你</span></div>
      <div class="panel-event-body"><p>上一条消息。</p></div>
    </article>
    <div class="panel-turn-asides">
      <article class="panel-event panel-event-user">
        <div class="panel-event-avatar"><span class="panel-event-glyph">你</span></div>
        <div class="panel-event-body"><p>插话一条。</p></div>
      </article>
    </div>
    <article class="panel-event panel-event-assistant is-run">
      <div class="panel-event-avatar">
        <span class="panel-event-glyph">鲸</span>
        <time class="panel-event-time">20:25</time>
      </div>
      <div class="panel-event-body">
        <div class="panel-cluster is-turn-process">
          <div class="panel-cluster-summary">
            <svg class="panel-cluster-chevron" viewBox="0 0 20 20"><path d="m8 4.8 5.2 5.2L8 15.2" /></svg>
            <span class="panel-cluster-label">已工作</span>
            <span class="panel-cluster-facts"><span>03:08</span></span>
            <span class="panel-cluster-state">✓</span>
          </div>
        </div>
        <div class="panel-run-item"><p>这里是回复正文，用来把消息块撑出高度。</p></div>
      </div>
    </article>
    <div class="panel-turn-stats" style="position: relative">
      <span class="panel-turn-stats-dot is-done"></span>
      <span>用时 03:08</span>
      <span class="panel-turn-usage">14.9M token（89 token/s）</span>
      <span class="panel-turn-usage panel-turn-tools">26 次工具</span>
    </div>
  </div>

  <div class="row big">
    ${Object.values(ICONS).map((p) => `<svg class="panel-tool-icon" viewBox="0 0 20 20">${p}</svg>`).join('')}
  </div>
  <div class="row tiny">
    ${Object.values(ICONS).map((p) => `<svg class="panel-tool-icon" viewBox="0 0 20 20">${p}</svg>`).join('')}
  </div>
</div>
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 700, height: 640, show: true, x: 60, y: 60,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  // 放大两倍渲染，1px 的错位在截图里就是 2px——肉眼能判。
  win.webContents.setZoomFactor(2)
  await new Promise((r) => setTimeout(r, 900))
  mkdirSync(CACHE, { recursive: true })
  const shot = path.join(CACHE, 'visual-check.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('shot:', shot)
  app.quit()
}, (error) => { console.error(error); app.quit() })
