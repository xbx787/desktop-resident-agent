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
/* Variant B — the compositor-only recipe, layered over the current file so the
   two run under identical conditions. */
.variant-b .panel-live-label {
  overflow: hidden;
  will-change: auto;
  filter: none;
  text-shadow: 0 0 7px rgba(111, 211, 255, .75);
  animation: b-breath 1.7s ease-in-out infinite;
}
.variant-b .panel-status .panel-live-label { text-shadow: 0 0 7px rgba(255, 214, 150, .85); }
.variant-b .panel-live-label::before {
  content: ''; position: absolute; left: 0; bottom: 0; width: 55%; height: 2px; border-radius: 2px;
  background-image: linear-gradient(90deg, transparent, #fff, #c9b8ff, transparent);
  animation: b-sweep 3.4s ease-in-out infinite;
}
.variant-b .panel-live-label::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: 0; right: auto; width: 55%; height: auto;
  background: linear-gradient(100deg, transparent, rgba(255,255,255,.6), transparent);
  animation: b-sweep 3.4s ease-in-out infinite;
}
@keyframes b-breath { 0%, 100% { opacity: .8; } 50% { opacity: 1; } }
@keyframes b-sweep { 0% { transform: translateX(-110%); } 50% { transform: translateX(190%); } 100% { transform: translateX(-110%); } }
</style></head>
<body><div class="stage" id="stage"></div>
<script>
const items = ${ITEMS};
const stage = document.getElementById('stage');
window.__fill = (variant) => {
  stage.className = 'stage' + (variant === 'b' ? ' variant-b' : '');
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

  const a = await measurePhase(win, 'a', 8000)
  writeFileSync(SHOT_A, a.shotted.toPNG())
  const b = await measurePhase(win, 'b', 8000)
  writeFileSync(SHOT_B, b.shotted.toPNG())

  const fmt = (u) => `renderer ${u.renderer.toFixed(1)}%  gpu ${u.gpu.toFixed(1)}%`
  console.log(`current recipe     (animated filter + background-position): ${fmt(a.usage)}`)
  console.log(`compositor recipe  (static text-shadow + opacity + transform): ${fmt(b.usage)}`)
  console.log(`shot A (current):    ${SHOT_A}`)
  console.log(`shot B (compositor): ${SHOT_B}`)
  app.exit(0)
})
