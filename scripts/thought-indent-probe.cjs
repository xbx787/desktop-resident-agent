// Thought-indent probe: renders one opened thinking row (the "已思考 11 秒"
// window) across four left-indent variants for its body text, so "the thought
// body is flush to the window's edge and looks stuck" is settled with numbers
// and one picture. Variants: a = 0 px (current), b = 8 px, c = 12 px,
// d = 22 px — flush with the "已思考" text (icon 14 + gap 8).
//
//   npx electron scripts/thought-indent-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')

const SPARK = '<svg class="panel-thought-icon" viewBox="0 0 20 20"></svg>'

const COLUMN = (id) => `
<div class="panel-bubble" id="${id}">
  <div class="panel-workspace">
    <div class="panel-feed-wrap">
      <div class="panel-feed">
        <div class="panel-cluster-body">
          <details class="panel-thought" open>
            <summary>${SPARK}<span class="panel-thought-label">已思考</span><span class="panel-thought-time">11 秒</span><span class="panel-thought-state" aria-hidden="true">✓</span></summary>
            <div class="panel-markdown"><p>先读屏幕左边的解析，确认公式和参数，再打开计算器一步步按出来。</p></div>
          </details>
        </div>
      </div>
    </div>
  </div>
</div>`

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
${['a', 'b', 'c', 'd'].map(COLUMN).join('\n')}
</body></html>`

const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  body { display: grid; grid-template-columns: repeat(2, 360px); gap: 16px; padding: 16px; }
  .panel-bubble { position: static; width: 360px; height: auto; max-height: none; }
  .panel-event, .panel-thought { content-visibility: visible; }
  .panel-feed { overflow: visible; padding: 4px 12px; }
  #a .panel-thought .panel-markdown { margin-left: 0; }
  #b .panel-thought .panel-markdown { margin-left: 8px; }
  #c .panel-thought .panel-markdown { margin-left: 12px; }
  #d .panel-thought .panel-markdown { margin-left: 22px; }
`

const MEASURE = `(() => {
  const out = {}
  for (const id of ['a', 'b', 'c', 'd']) {
    const col = document.getElementById(id)
    const base = col.querySelector('.panel-thought').getBoundingClientRect().x
    const x = (el) => el ? +(el.getBoundingClientRect().x - base).toFixed(1) : null
    out[id] = {
      icon: x(col.querySelector('.panel-thought-icon')),
      label: x(col.querySelector('.panel-thought-label')),
      body: x(col.querySelector('.panel-markdown p')),
    }
  }
  return JSON.stringify(out)
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 560, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(300)
  const result = await win.webContents.executeJavaScript(MEASURE)
  const shot = path.join(os.tmpdir(), 'thought-indent-probe.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('MEASURED ' + result)
  console.log('shot: ' + shot)
  app.exit(0)
})
