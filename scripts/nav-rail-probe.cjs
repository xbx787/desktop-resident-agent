// Nav-rail probe: the resting handle (a few newest marks beside the messages)
// and the expanded, wheel-slidable window with a hover card — both rendered
// with the real panel.css.
//
//   npx electron scripts/nav-rail-probe.cjs
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'panel.css').replace(/\\/g, '/')
const SHOT = path.join(os.tmpdir(), 'nav-rail.png')

const marks = (count, activeAt = -1) => Array.from({ length: count }, (_, i) => {
  const boost = activeAt < 0 ? 0 : Math.max(0, 10 - Math.abs(i - activeAt) * 2)
  const cls = `panel-nav-mark${i % 6 === 0 ? ' is-user' : ''}${i === activeAt ? ' is-active' : ''}`
  return `<i class="${cls}"${boost ? ` style="--nav-boost:${boost}px"` : ''}></i>`
}).join('')

const card = (offset) => `<div class="panel-nav-card" style="top: clamp(40px, calc(50% + ${offset}px), calc(100% - 40px))">
  <span class="panel-nav-role">小鲸</span>
  <p class="panel-nav-text">悬停到刻度上会浮出这个内容卡：这一段是回复的开头，滚轮可以翻动整条导航。</p>
</div>`

const bubble = (label, nav, cardHtml) => `<div style="display:grid;gap:8px">
  <span style="color:#8fa9d9;font-size:10px">${label}</span>
  <div class="panel-bubble" style="position:relative;right:auto;bottom:auto;transform:none;width:356px;height:400px">
    <div class="panel-feed-wrap" style="height:100%">
      <div class="panel-nav${nav.expanded ? ' is-expanded' : ''}">${marks(nav.count, nav.activeAt ?? -1)}</div>
      ${cardHtml || ''}
    </div>
  </div>
</div>`

const page = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="${CSS_PATH}">
<style>body { margin: 0; padding: 16px; background: #0b1428; display: flex; gap: 26px; align-items: flex-start; }</style></head>
<body>
${bubble('收起态：只露最近 3 格', { expanded: false, count: 3 })}
${bubble('展开态：45 格窗口 + 悬停卡（弧形）', { expanded: true, count: 45, activeAt: 21 }, card(21 * 6 - 132))}
</body></html>`

app.whenReady().then(async () => {
  const pagePath = path.join(os.tmpdir(), `nav-rail-probe-${process.pid}.html`)
  writeFileSync(pagePath, page)
  const win = new BrowserWindow({ width: 880, height: 500, show: true, frame: false, alwaysOnTop: true, focusable: false })
  await win.loadFile(pagePath)
  win.showInactive()
  await new Promise((resolve) => setTimeout(resolve, 900))
  writeFileSync(SHOT, (await win.webContents.capturePage()).toPNG())
  console.log(`shot: ${SHOT}`)
  app.exit(0)
})
