// Effort slider probe: renders the thinking-depth row exactly as the menu
// shows it, so the "like the iOS reference" shape (fat capsule track, big
// ticks, big knob) can be eyeballed without launching the app.
//
//   npx electron scripts/effort-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')
const SHOT = path.join(os.tmpdir(), 'effort-row.png')

// Four stops (off/low/high/max) with the thumb on "max": the two middle ticks
// are past, the fill spans the whole track — the same state as the reference.
const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
  <div class="panel-bubble" style="position:static;display:block;width:240px;height:auto;min-height:0">
    <div class="panel-effort-menu is-open" style="position:static;width:220px">
      <div class="panel-effort-row">
        <div class="panel-effort-slider-wrap">
          <span class="panel-effort-track" aria-hidden="true">
            <span class="panel-effort-fill" style="width:33.3333%"></span>
            <i class="panel-effort-tick is-past" style="left:calc(18px + (100% - 36px) * 0.0000)"></i>
            <i class="panel-effort-tick is-past" style="left:calc(18px + (100% - 36px) * 0.3333)"></i>
            <i class="panel-effort-tick" style="left:calc(18px + (100% - 36px) * 0.6667)"></i>
            <i class="panel-effort-tick" style="left:calc(18px + (100% - 36px) * 1.0000)"></i>
          </span>
          <input type="range" class="panel-effort-slider" min="0" max="3" step="1" value="1" aria-label="思考强度">
        </div>
        <span class="panel-effort-value">低</span>
      </div>
    </div>
  </div>
</body></html>`

const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; padding: 20px; }
  .panel-bubble { position: static; min-width: 0; }
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MEASURE = `(() => {
  const r = (s) => document.querySelector(s).getBoundingClientRect()
  const round = (v) => +v.toFixed(2)
  const input = r('.panel-effort-slider'), track = r('.panel-effort-track'), fill = r('.panel-effort-fill'), value = r('.panel-effort-value')
  const ticks = [...document.querySelectorAll('.panel-effort-tick')].map((el) => { const t = el.getBoundingClientRect(); return round(t.left + t.width / 2) })
  return JSON.stringify({
    input: [round(input.left), round(input.right), round(input.width)],
    track: [round(track.left), round(track.right), round(track.width)],
    fillRight: round(fill.right),
    valueLeft: round(value.left),
    tickCenters: ticks,
  })
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 200, show: true, backgroundColor: '#0c1b3e' })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(400)
  const measured = await win.webContents.executeJavaScript(MEASURE)
  console.log('MEASURED ' + measured)
  if (process.env.PROBE_SHOT === '1') writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
  app.exit(0)
})
