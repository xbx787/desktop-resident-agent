// Live-label motion probe: renders the same set of live labels twice in one
// real Electron window — once with the current recipe (animated `filter:
// drop-shadow` + animated `background-position`) and once with the
// compositor-only recipe (static `text-shadow` glow + opacity breath +
// transform-swept bars). Reports renderer and GPU CPU percentage for each
// phase and writes a screenshot of each, so the visual delta can be eyeballed
// next to the numbers.
//
//   npx electron scripts/live-label-probe.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'panel.css').replace(/\\/g, '/')
const SHOT_A = path.join(os.tmpdir(), 'live-label-current.png')
const SHOT_B = path.join(os.tmpdir(), 'live-label-compositor.png')
const ITEMS = 80

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="${CSS_PATH}">
<style>
body { margin: 0; background: linear-gradient(155deg, #26417d, #0c1b3e); }
.stage { padding: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 5px 14px; }
.cell { display: flex; align-items: center; gap: 10px; color: #c5d6fb; font: 11px 'Microsoft YaHei UI', sans-serif; }
/* Peel the current recipe apart one ingredient at a time to see which piece
   owns the cost: b = no breathing, c = no glyph sheen (::after), d = none of
   breath/sheen/shadow, e = fully static (baseline). */
.variant-b .panel-live-label { animation: none; opacity: 1; }
.variant-c .panel-live-label::after { display: none; }
.variant-d .panel-live-label { animation: none; opacity: 1; text-shadow: none; }
.variant-d .panel-live-label::after { display: none; }
.variant-e .panel-live-label { animation: none; opacity: 1; text-shadow: none; }
.variant-e .panel-live-label::before, .variant-e .panel-live-label::after { display: none; }
</style></head>
<body><div class="stage" id="stage"></div>
<script>
const items = ${ITEMS};
const stage = document.getElementById('stage');
window.__fill = (variant) => {
  stage.className = 'stage' + (variant === 'a' ? '' : ' variant-' + variant);
  stage.innerHTML = '';
  for (let i = 0; i < items; i++) {
    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.innerHTML = '<span class="panel-status"><i></i><span class="panel-live-label">正在整理任务</span></span><span class="panel-live-label">执行命令</span>';
    stage.appendChild(cell);
  }
};
</script></body></html>`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readUsage() {
  const metrics = app.getAppMetrics()
  const pick = (type) => metrics.filter((m) => m.type === type).reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0)
  return { renderer: pick('Tab'), gpu: pick('GPU') }
}

async function measurePhase(win, variant, millis) {
  await win.webContents.executeJavaScript(`window.__fill('${variant}')`)
  await sleep(2000) // warm-up: animations run, styles settle
  const before = readUsage() // noqa: establishes the sampling window start
  await sleep(millis)
  const usage = readUsage()
  const shot = await win.webContents.capturePage()
  return { usage, before, shotted: shot }
}

app.whenReady().then(async () => {
  const pagePath = path.join(os.tmpdir(), `live-label-probe-${process.pid}.html`)
  writeFileSync(pagePath, page)
  const win = new BrowserWindow({
    width: 430, height: 320, x: 40, y: 40, show: false, focusable: false, frame: false,
    webPreferences: { sandbox: false, backgroundThrottling: false }
  })
  await win.loadFile(pagePath)
  win.showInactive()
  await sleep(800)

  const LABELS = {
    a: 'current       (breath + bottom bar + glyph sheen + shadow)',
    b: 'no breath     (bars + sheen + shadow)',
    c: 'no sheen      (breath + bottom bar + shadow)',
    d: 'no breath/shadow (bottom bar only)',
    e: 'fully static  (baseline)',
  }
  const fmt = (u) => `renderer ${u.renderer.toFixed(1)}%  gpu ${u.gpu.toFixed(1)}%`
  for (const variant of ['a', 'b', 'c', 'd', 'e']) {
    const phase = await measurePhase(win, variant, 8000)
    if (variant === 'a') writeFileSync(SHOT_A, phase.shotted.toPNG())
    if (variant === 'd') writeFileSync(SHOT_B, phase.shotted.toPNG())
    console.log(`${variant}  ${LABELS[variant]}: ${fmt(phase.usage)}`)
  }
  console.log(`shot A (current):  ${SHOT_A}`)
  console.log(`shot D (trimmed):  ${SHOT_B}`)
  app.exit(0)
})
