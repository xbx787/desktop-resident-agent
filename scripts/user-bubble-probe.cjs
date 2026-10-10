// User bubble probe: renders one-line and two-line user messages in the real
// Chromium layout engine and reports their geometry, so "the one-line bubble
// looks too tall" stays settled with numbers instead of arithmetic. A healthy
// one-line bubble is ~39px (text + padding), not stretched to the 44px avatar
// column; multi-line bubbles run taller and unchanged.
//
//   npx electron scripts/user-bubble-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
  <div class="panel-bubble">
    <div class="panel-workspace">
      <div class="panel-feed-wrap">
        <div class="panel-feed">
          <div id="one-line" class="panel-event panel-event-user">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">你</span><time class="panel-event-time">17:50</time></div>
            <div class="panel-event-body"><p>测试一行短消息</p></div>
          </div>
          <div id="two-line" class="panel-event panel-event-user">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">你</span><time class="panel-event-time">17:50</time></div>
            <div class="panel-event-body"><p>这是一条足够长的消息内容用来验证多行时气泡的高度表现它应该保持自然高度不被拉伸</p></div>
          </div>
          <div id="no-clock" class="panel-event panel-event-user">
            <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">你</span></div>
            <div class="panel-event-body"><p>没有时间戳的一行消息</p></div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body></html>`

// Sandbox-only overrides: make the bubble a static, fixed-width box at the
// top of the page, and disable content-visibility so every row really lays out.
const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  .panel-bubble { position: static; width: 420px; height: auto; max-height: none; }
  .panel-event { content-visibility: visible; }
`


const MEASURE = `(() => {
  const m = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    return { h: +r.height.toFixed(2), w: +r.width.toFixed(2), cw: cs.width, disp: cs.display }
  }
  const row = (id) => ({
    row: m('#' + id),
    avatar: m('#' + id + ' .panel-event-avatar'),
    body: m('#' + id + ' .panel-event-body'),
    p: m('#' + id + ' .panel-event-body p'),
  })
  return JSON.stringify({ oneLine: row('one-line'), twoLine: row('two-line'), noClock: row('no-clock') })
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 520, height: 700, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(300)
  const result = await win.webContents.executeJavaScript(MEASURE)
  writeFileSync(path.join(os.tmpdir(), 'user-bubble.png'), (await win.capturePage()).toPNG())
  console.log('MEASURED ' + result)
  console.log('shot: ' + path.join(os.tmpdir(), 'user-bubble.png'))
  app.exit(0)
})
