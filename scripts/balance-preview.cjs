// 余额卡预览：按人物三档高度渲染卡片，右侧画出人物可见区，看对齐与间距。
//
//   npx electron scripts/balance-preview.cjs   → .cache/balance-preview.png
'use strict'
const { app, BrowserWindow } = require('electron')
const { readFileSync, mkdirSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const CACHE = path.join(ROOT, '.cache')
const TOKENS = readFileSync(path.join(ROOT, 'src', 'renderer', 'design-tokens.css'), 'utf8')
const BALANCE = readFileSync(path.join(ROOT, 'src', 'renderer', 'balance.css'), 'utf8')

const card = (notice = '', vars = '') => `<aside class="balance-peek${notice ? ' has-notice' : ''}" style="${vars}">
  <div class="balance-header">
    <span class="balance-heading"><strong>DeepSeek</strong><small>余额</small><small class="balance-updated">21:06</small></span>
    <div class="balance-actions"><button type="button">↻</button><button type="button">×</button></div>
  </div>
  <div class="balance-amounts">
    <span class="balance-amount"><strong>¥248.59</strong><small>CNY</small></span>
  </div>
  <div class="balance-period">
    <span class="balance-period-badge balance-period-off_peak">谷时</span>
    <span class="balance-next">00:12 转峰时</span>
  </div>
  ${notice ? `<div class="balance-foot"><span>${notice}</span></div>` : ''}
</aside>`

const CARD_WINDOW_HEIGHT = 134
const scene = (size, height, width, notice = '') => `
<div class="scene" style="height:${height}px">
  <div class="window" style="width:248px;height:${CARD_WINDOW_HEIGHT}px">${card(notice)}</div>
  <div class="role" style="width:${width}px;height:${height}px"><span>人物<br>可见区</span></div>
</div>
<p class="caption"><b>${size}</b> · 卡片窗口 248×${CARD_WINDOW_HEIGHT}（三档一致），卡片 240 宽；右侧三角尖到人物左缘 4px。</p>`

const HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
${TOKENS}
${BALANCE}
body { margin: 0; background: #101d38; color: #cbd7ee; font-family: var(--font-ui); }
.harness { width: 500px; padding: 22px 20px 24px; }
.scene { position: relative; display: flex; align-items: center; gap: 4px; margin-top: 14px; margin-bottom: 30px; }
.window { position: relative; flex: none; transform: translateY(-6px); }
.window .balance-peek { position: absolute; top: 0; left: 0; right: 8px; bottom: auto; width: auto; height: 100%; }
.window .balance-peek::after { top: calc(50% - 6px); right: -6px; }
.role { display: grid; place-items: center; flex: none; border: 1px dashed rgba(150, 188, 245, .45); border-radius: 42% 42% 18% 18%; background: linear-gradient(180deg, rgba(120, 164, 230, .22), rgba(80, 120, 190, .08)); color: rgba(180, 205, 245, .75); font-size: 10px; text-align: center; line-height: 1.5; }
.caption { margin: 8px 0 0; color: #8fa6cf; font-size: 11px; line-height: 1.5; }
.caption b { color: #d8e4fa; font-weight: 600; }
.wide-role { opacity: .65; }
</style></head><body>
<div class="harness">
  ${scene('小 · 人物 128', 128, 107)}
  ${scene('中 · 人物 140', 140, 116)}
  ${scene('大 · 人物 152', 152, 127)}
  ${scene('错误提示', 128, 107, '账户当前不可调用 API')}
</div>
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 900, height: 1100, show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  win.webContents.setZoomFactor(1.5)
  await new Promise((resolve) => setTimeout(resolve, 900))
  mkdirSync(CACHE, { recursive: true })
  const shot = path.join(CACHE, 'balance-preview.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('shot:', shot)
  app.quit()
}, (error) => { console.error(error); app.quit() })
