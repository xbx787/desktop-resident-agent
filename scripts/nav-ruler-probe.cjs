// Nav ruler probe: renders the message rail in the real Chromium layout
// engine and reports every mark's position in physical pixels, so "the rows
// are unevenly spaced by one device pixel" (9/10 alternating) is measured
// instead of argued about. A healthy rail has a constant pitch across every
// pair of neighbours, in device pixels, at the machine's real scale factor.
//
//   npx electron scripts/nav-ruler-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')
const SHOT = path.join(os.tmpdir(), 'nav-ruler.png')

const marks = (count) => Array.from({ length: count }, (_, index) =>
  `<i class="panel-nav-mark${index % 2 ? '' : ' is-user'}"></i>`).join('')
const railHeight = (count) => 12 + Math.max(0, count - 1) * 5.6 + 3.2

const pane = (id, navInner) => `
  <div class="panel-bubble" style="position:static;width:420px;height:358px">
    <div class="panel-workspace"><div class="panel-feed-wrap">
      ${navInner.replace('__ID__', id)}
    </div></div>
  </div>`

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
  ${pane('rail12', `<div class="panel-nav is-expanded" id="__ID__" style="height:${railHeight(12)}px">${marks(12)}</div>`)}
  ${pane('rail60', `<div class="panel-nav is-expanded" id="__ID__" style="height:${railHeight(60)}px">${marks(60)}</div>`)}
  ${pane('resting', `<div class="panel-nav" id="__ID__">${marks(3)}</div>`)}
</body></html>`

// Sandbox-only: the probe pans sit in normal flow, not anchored to a real panel.
const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  .panel-bubble { position: static; min-width: 0; }
  .panel-event { content-visibility: visible; }
`

const MEASURE = `(() => {
  const dpr = devicePixelRatio
  const phys = (id) => [...document.querySelectorAll('#' + id + ' .panel-nav-mark')]
    .map((el) => el.getBoundingClientRect().top * dpr)
  const diffs = (arr) => arr.slice(1).map((v, i) => +(v - arr[i]).toFixed(4))
  const uniq = (arr) => [...new Set(arr)]
  const r12 = phys('rail12'), r60 = phys('rail60'), rest = phys('resting')
  const frac = (arr) => uniq(arr.map((v) => +(v - Math.round(v)).toFixed(4)))
  return JSON.stringify({
    dpr,
    rail12: { tops: r12.map((v) => +v.toFixed(3)), diffs: diffs(r12), frac: frac(r12) },
    rail60: { n: r60.length, diffsUniq: uniq(diffs(r60)), frac: frac(r60) },
    resting: { diffs: diffs(rest), frac: frac(rest) },
  })
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 470, height: 1200, show: true, backgroundColor: '#0c1b3e' })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(350)
  const result = await win.webContents.executeJavaScript(MEASURE)
  writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
  console.log('MEASURED ' + result)
  console.log('shot: ' + SHOT)
  app.exit(0)
})
