// Blur-surface probe: a transparent Electron window (the pet's own environment)
// with a panel-sized surface over a backdrop, measured with and without
// `backdrop-filter: blur(24px)`. The panel is 96% opaque, so the blur is
// invisible — this probe puts a number on what it costs anyway.
//
//   npx electron scripts/blur-surface-probe.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>
html, body { margin: 0; width: 100%; height: 100%; background: transparent; overflow: hidden; }
.behind { position: absolute; inset: 0; background:
  radial-gradient(circle at 20% 20%, #7fb4ff 0 18%, transparent 42%),
  radial-gradient(circle at 80% 70%, #ff9fb2 0 14%, transparent 38%),
  linear-gradient(140deg, #1c2f5e, #0a1430); }
.panel { position: absolute; left: 24px; top: 24px; width: 356px; height: 300px; border-radius: 18px;
  border: 1px solid rgba(184, 209, 255, .28);
  background: linear-gradient(155deg, rgba(38, 65, 125, .97), rgba(21, 39, 83, .96) 45%, rgba(11, 26, 61, .96));
  color: #edf3ff; font: 11px 'Microsoft YaHei UI', sans-serif; padding: 12px; }
.panel.blurred { backdrop-filter: blur(24px) saturate(1.15); -webkit-backdrop-filter: blur(24px) saturate(1.15); }
.row { padding: 6px 4px; border-bottom: 1px solid rgba(120, 150, 220, .18); }
</style></head>
<body>
<div class="behind"></div>
<div class="panel" id="panel">${Array.from({ length: 14 }, (_, i) => `<div class="row">第 ${i + 1} 行消息预览内容</div>`).join('')}</div>
<script>window.__setBlur = (on) => document.getElementById('panel').classList.toggle('blurred', on)</script>
</body></html>`

function readUsage() {
  const metrics = app.getAppMetrics()
  const pick = (type) => metrics.filter((m) => m.type === type).reduce((sum, m) => sum + (m.cpu?.percentCPUUsage ?? 0), 0)
  return { renderer: pick('Tab'), gpu: pick('GPU') }
}

app.whenReady().then(async () => {
  const pagePath = path.join(os.tmpdir(), `blur-surface-probe-${process.pid}.html`)
  writeFileSync(pagePath, page)
  const win = new BrowserWindow({
    width: 420, height: 360, x: 60, y: 60, show: false, focusable: false, frame: false,
    transparent: true, backgroundColor: '#00000000', hasShadow: false,
    webPreferences: { sandbox: false, backgroundThrottling: false }
  })
  await win.loadFile(pagePath)
  win.showInactive()
  await sleep(1200)

  const measure = async (blurred, label) => {
    await win.webContents.executeJavaScript(`window.__setBlur(${blurred})`)
    await sleep(1500) // warm-up / settle
    readUsage() // start the sampling window
    await sleep(8000)
    const usage = readUsage()
    console.log(`${label.padEnd(20)} renderer ${usage.renderer.toFixed(1)}%  gpu ${usage.gpu.toFixed(1)}%`)
  }

  await measure(true, 'with backdrop blur')
  await measure(false, 'without backdrop blur')
  await measure(true, 'with backdrop blur (again)')
  await measure(false, 'without (again)')
  app.exit(0)
})
