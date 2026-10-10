// Thread & glow probe: renders (left) a reply fragmented into pieces on the
// new thread line — first piece with avatar and clock, the rest bare but
// aligned — and (right) the live label caught at five sweep phases, so the
// brightness and the (absent) edge clipping can be eyeballed.
//
//   npx electron scripts/thread-glow-probe.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'panel.css').replace(/\\/g, '/')
const SHOT = path.join(os.tmpdir(), 'thread-glow.png')

const glyph = (text) => `<span class="panel-avatar-img" style="display:grid;place-items:center;background:#3d5c99;color:#eaf2ff;font-size:11px">${text}</span>`

const feed = `<div class="panel-bubble" style="position:relative;right:auto;bottom:auto;transform:none;width:356px;padding:12px 10px 6px;display:block">
  <div class="panel-turn">
    <article class="panel-event panel-event-assistant is-run">
      <div class="panel-event-avatar" aria-hidden="true">${glyph('鲸')}<time class="panel-event-time">15:52</time></div>
      <div class="panel-event-body">
        <div class="panel-run-item"><div class="panel-markdown"><p>这一段是回复的第一句，头像和时钟只出现这一次。</p></div></div>
        <div class="panel-run-item"><div class="panel-markdown"><p>思考了一下的第二句，作为列表项接续，点由段落自身绘制。</p></div></div>
        <div class="panel-run-item"><div class="panel-markdown"><p>然后是第三句。</p></div></div>
        <div class="panel-run-item"><div class="panel-markdown"><p>最后一句，收束。</p></div></div>
      </div>
    </article>
  </div>
</div>`

const phases = [0, -0.85, -1.7, -2.55, -3.39]
const labels = ['0.00s 光在左外', '-0.85s 光在中央', '-1.70s 光在右外', '-2.55s 回程中', '-3.39s 到达左外']
const glow = phases.map((delay, index) => `<div style="display:flex;align-items:center;gap:10px;min-height:30px">
  <span style="color:#7f95bd;font-size:10px;width:104px">${labels[index]}</span>
  <span class="panel-status panel-status-executing"><i style="animation-play-state: paused; animation-delay: -0.6s"></i><span class="panel-live-label" style="animation: panel-live-breath 1.7s ease-in-out infinite, panel-live-sweep 3.4s ease-in-out infinite; animation-delay: ${delay}s, ${delay}s; animation-play-state: paused;">正在整理任务</span></span>
</div>`).join('')

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="${CSS_PATH}">
<style>
body { margin: 0; padding: 16px; background: #0b1428; display: flex; gap: 20px; align-items: flex-start; }
.stage { background: linear-gradient(155deg, #233f7a, #0c1b3e); border-radius: 18px; padding: 14px; }
</style></head>
<body>
  <div class="stage">${feed}</div>
  <div class="stage"><div style="display:grid;gap:8px">${glow}</div></div>
</body></html>`

app.whenReady().then(async () => {
  const pagePath = path.join(os.tmpdir(), `thread-glow-probe-${process.pid}.html`)
  writeFileSync(pagePath, page)
  const win = new BrowserWindow({ width: 810, height: 460, show: true, frame: false, alwaysOnTop: true, focusable: false })
  await win.loadFile(pagePath)
  win.webContents.setZoomFactor(1.8)
  win.showInactive()
  await new Promise((resolve) => setTimeout(resolve, 900))
  writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
  console.log(`shot: ${SHOT}`)
  app.exit(0)
})
