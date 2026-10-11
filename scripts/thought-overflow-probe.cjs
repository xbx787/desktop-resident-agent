// Thought-overflow probe: renders real wide-content suspects (inline/block
// KaTeX, a markdown table, a long code line, a long URL) inside a 356 px
// bubble — once directly in the feed, once inside an opened thinking row —
// and reports every scroll container whose content is wider than its box, so
// "a horizontal scrollbar shows up in the small window" names its culprit
// instead of its symptom.
//
//   npx electron scripts/thought-overflow-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const katex = require(path.join(__dirname, '..', 'node_modules', 'katex'))

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')
const KATEX_CSS = readFileSync(path.join(__dirname, '..', 'node_modules', 'katex', 'dist', 'katex.min.css'), 'utf8')

const INLINE_MATH = katex.renderToString('\\frac{EBIT - i}{1 - T_C} + \\frac{R_S - G}{R_S \\times G} \\approx 27870.02', { output: 'html' })
const DISPLAY_MATH = katex.renderToString('\\text{税后} = (EBIT - i)(1 - T_C) = (1200 - 100) \\times (1 - 25\\%) = 825', { displayMode: true, output: 'html' })

const SUSPECTS = `
<p>普通一段中文文本，长度适中，用来核对换行是否正常，这一段理应完整折行不产生横向溢出。</p>
<p>带行内公式的一行：${INLINE_MATH}</p>
${DISPLAY_MATH}
<div class="panel-code-block"><pre>dividend_yield = (eps * payout_ratio) / price_per_share + expected_growth_rate - inflation_adjustment</pre></div>
<p><a href="https://example.com/a/very/long/path/that/keeps/going/and/going/without/spaces/at/all/because/urls/can/do/that">https://example.com/a/very/long/path/that/keeps/going/and/going/without/spaces/at/all/because/urls/can/do/that</a></p>
<table><thead><tr><th>项目</th><th>公式</th><th>数值</th><th>备注</th></tr></thead><tbody><tr><td>EBIT</td><td>营业利润 + 财务费用</td><td>1200</td><td>来源：题目给定</td></tr></tbody></table>
`

const THOUGHT = (inner) => `
<details class="panel-thought" open>
  <summary><svg class="panel-thought-icon" viewBox="0 0 20 20"></svg><span class="panel-thought-label">已思考</span><span class="panel-thought-time">11 秒</span><span class="panel-thought-state" aria-hidden="true">✓</span></summary>
  <div class="panel-markdown">${inner}</div>
</details>`

const COLUMN = (id, inner) => `
<div class="panel-bubble" id="${id}">
  <div class="panel-workspace">
    <div class="panel-feed-wrap">
      <div class="panel-feed">
        <article class="panel-event panel-event-assistant is-run">
          <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">鲸</span></div>
          <div class="panel-event-body">
            <details class="panel-cluster is-turn-process" open>
              <summary class="panel-cluster-summary"><svg class="panel-cluster-chevron" viewBox="0 0 20 20"></svg><span class="panel-cluster-facts"><span>用时 03:55</span></span><span class="panel-cluster-state" aria-hidden="true">✓</span></summary>
              <div class="panel-cluster-body">
                <details class="panel-cluster" open>
                  <summary class="panel-cluster-summary"><svg class="panel-cluster-chevron" viewBox="0 0 20 20"></svg><span class="panel-cluster-facts"><span>用时 00:11</span></span><span class="panel-cluster-state" aria-hidden="true">✓</span></summary>
                  <div class="panel-cluster-body">
                    ${inner}
                  </div>
                </details>
              </div>
            </details>
          </div>
        </article>
      </div>
    </div>
  </div>
</div>`

const HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>probe</title></head><body>
${COLUMN('feed', `<div class="panel-run-item"><div class="panel-markdown">${SUSPECTS}</div></div>`)}
${COLUMN('thought', THOUGHT(SUSPECTS))}
</body></html>`

const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  body { display: flex; gap: 16px; padding: 16px; align-items: flex-start; }
  .panel-bubble { position: static; width: 356px; height: auto; max-height: none; }
  .panel-event, .panel-thought { content-visibility: visible; }
  .panel-feed { max-height: none; }
`

const MEASURE = `(() => {
  const report = (root) => {
    const scrollers = []
    for (const el of [root, ...root.querySelectorAll('*')]) {
      const r = el.getBoundingClientRect()
      const overX = el.scrollWidth - el.clientWidth
      if (overX > 1) scrollers.push({ sel: (el.className || el.tagName) + '', overX, ox: getComputedStyle(el).overflowX, w: +r.width.toFixed(1), sw: el.scrollWidth, y: +r.y.toFixed(0) })
    }
    const boxes = [...root.querySelectorAll('.katex-display, pre')].map((el) => ({
      sel: el.className || el.tagName, y: +el.getBoundingClientRect().y.toFixed(0),
      fs: el.style.fontSize || '(base)', w: el.clientWidth, sw: el.scrollWidth,
    }))
    return { scrollers, boxes }
  }
  return JSON.stringify({
    feed: report(document.getElementById('feed')),
    thought: report(document.getElementById('thought')),
  })
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The MessageMarkdown fit pass, mirrored: reset, measure, shrink toward the
// box (floor 8 px). Running it here shows the fitted state the app will have.
const FIT = `(() => {
  for (const el of document.querySelectorAll('.panel-markdown .katex-display')) {
    el.style.fontSize = ''
    const base = parseFloat(getComputedStyle(el).fontSize)
    const full = el.scrollWidth, vis = el.clientWidth
    let size = base
    if (base > 0 && vis > 0 && full > vis) size = Math.max(8, base * vis / full)
    if (size < base) el.style.fontSize = size + 'px'
  }
  return 'fitted'
})()`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 800, height: 1400, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(KATEX_CSS)
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(400)
  await win.webContents.executeJavaScript(FIT)
  const result = await win.webContents.executeJavaScript(MEASURE)
  const shot = path.join(os.tmpdir(), 'thought-overflow-probe.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('MEASURED ' + result)
  console.log('shot: ' + shot)
  app.exit(0)
})
