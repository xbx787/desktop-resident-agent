// Avatar thread probe: renders a running turn and reports the physical
// geometry of the avatar column's thread line, the turn-stats pulse dot and
// the gap between them — so "the line misses the dot" stays settled with
// numbers. A healthy rail has all three axes equal and the stats bridge
// spanning exactly the article-to-stats gap.
//
//   npx electron scripts/avatar-thread-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')
const SHOT = path.join(os.tmpdir(), 'avatar-thread.png')

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
  <div class="panel-bubble" style="position:static;width:356px;height:auto">
    <div class="panel-workspace"><div class="panel-feed-wrap"><div class="panel-feed">
      <div class="panel-turn">
        <article class="panel-event panel-event-assistant is-run">
          <div class="panel-event-avatar" aria-hidden="true">
            <span class="panel-event-glyph">鲸</span>
            <time class="panel-event-time">23:37</time>
          </div>
          <div class="panel-event-body">
            <p>正在处理这个请求，请稍等片刻。</p>
            <p>再补一段文字把消息块垫高，让竖线有足够的行程可以看出来。</p>
          </div>
        </article>
        <div class="panel-turn-stats" role="status">
          <span class="panel-turn-stats-dot is-running" aria-hidden="true"></span>
          <span class="panel-turn-usage">387.1K token</span>
          <span class="panel-turn-usage panel-turn-tools">1 次工具</span>
        </div>
      </div>
      <div class="panel-turn" id="done">
        <article class="panel-event panel-event-assistant is-run">
          <div class="panel-event-avatar" aria-hidden="true">
            <span class="panel-event-glyph">鲸</span>
            <time class="panel-event-time">23:37</time>
          </div>
          <div class="panel-event-body">
            <p>这个回合已经写完，点应该安静地变成蓝色。</p>
          </div>
        </article>
        <div class="panel-turn-stats" role="status">
          <span class="panel-turn-stats-dot is-done" aria-hidden="true"></span>
          <span>用时 00:12</span>
          <span class="panel-turn-usage">387.1K token</span>
          <span class="panel-turn-usage panel-turn-tools">1 次工具</span>
        </div>
      </div>
    </div></div></div>
  </div>
</body></html>`

const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  .panel-bubble { position: static; min-width: 0; }
  .panel-event { content-visibility: visible; }
`

const MEASURE = `(() => {
  const rect = (sel) => document.querySelector(sel).getBoundingClientRect()
  const avatar = rect('.panel-event-avatar')
  const glyph = rect('.panel-event-glyph')
  const article = rect('.panel-event-assistant')
  const stats = rect('.panel-turn-stats')
  const pulse = rect('.panel-turn-stats-dot')
  const doneDot = rect('#done .panel-turn-stats-dot')
  const doneAvatar = rect('#done .panel-event-avatar')
  const round = (v) => +v.toFixed(2)
  return JSON.stringify({
    avatarAxis: round(avatar.left + avatar.width / 2),
    glyphAxis: round(glyph.left + glyph.width / 2),
    pulseAxis: round(pulse.left + pulse.width / 2),
    lineBottom: round(avatar.bottom),
    articleBottom: round(article.bottom),
    statsTop: round(stats.top),
    gap: round(stats.top - article.bottom),
    bridgeNeeded: round(pulse.top - article.bottom),
    pulseTop: round(pulse.top),
    pulseCenterY: round(pulse.top + pulse.height / 2),
    doneDotAxis: round(doneDot.left + doneDot.width / 2),
    doneAvatarAxis: round(doneAvatar.left + doneAvatar.width / 2),
  })
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 420, height: 420, show: true, backgroundColor: '#0c1b3e' })
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
