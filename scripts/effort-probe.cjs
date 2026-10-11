// Effort slider probe: renders the thinking-depth row at all four stops in
// one real Electron window, measures every tick's centre against the native
// thumb's actual resting centre at that stop (input box + 24 px thumb maths),
// and screenshots the rows — so "the ends don't sit on the white dots" is
// settled with numbers and one picture.
//
//   npx electron scripts/effort-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')
const SHOT = path.join(os.tmpdir(), 'effort-row.png')
const LEVELS = ['关闭', '低', '高', '最大']

const ROW = (v) => {
  const stop = (t) => `calc(9px + (100% - 18px) * ${(t / (LEVELS.length - 1)).toFixed(4)})`
  const ticks = LEVELS.map((_, t) => `<i class="panel-effort-tick${t <= v ? ' is-past' : ''}" style="left:${stop(t)}"></i>`).join('')
  return `
      <div class="panel-effort-row">
        <div class="panel-effort-slider-wrap">
          <span class="panel-effort-track" aria-hidden="true">
            <span class="panel-effort-fill" style="width:${stop(v)}"></span>
            ${ticks}
          </span>
          <input type="range" class="panel-effort-slider" min="0" max="3" step="1" value="${v}" aria-label="思考强度">
        </div>
        <span class="panel-effort-value">${LEVELS[v]}</span>
      </div>`
}

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
  <div class="panel-bubble" style="position:static;display:block;width:260px;height:auto;min-height:0">
    <div class="panel-effort-menu is-open" style="position:static;width:240px">
${LEVELS.map((_, v) => ROW(v)).join('\n')}
    </div>
  </div>
</body></html>`

const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; padding: 20px; }
  .panel-bubble { position: static; min-width: 0; }
  .panel-effort-menu { position: static !important; transform: none !important; }
`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const MEASURE = `(() => {
  const round = (v) => +v.toFixed(2)
  return JSON.stringify([...document.querySelectorAll('.panel-effort-row')].map((row) => {
    const slider = row.querySelector('.panel-effort-slider')
    const input = slider.getBoundingClientRect()
    const value = Number(slider.value)
    // The thumb is 24 px wide and the input box reaches 12 px past the wrap on
    // each side, so the thumb's centre rests exactly at ratio * wrap width.
    const thumbCentre = input.left + 12 + (value / 3) * (input.width - 24)
    const ticks = [...row.querySelectorAll('.panel-effort-tick')].map((el) => {
      const t = el.getBoundingClientRect()
      return round(t.left + t.width / 2)
    })
    return { value, thumbCentre: round(thumbCentre), ticks, deltas: ticks.map((centre) => round(centre - thumbCentre)) }
  }))
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 480, height: 300, show: true, backgroundColor: '#0c1b3e' })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(400)
  const measured = await win.webContents.executeJavaScript(MEASURE)
  writeFileSync(SHOT, (await win.capturePage()).toPNG())
  console.log('MEASURED ' + measured)
  console.log('shot: ' + SHOT)
  app.exit(0)
})
