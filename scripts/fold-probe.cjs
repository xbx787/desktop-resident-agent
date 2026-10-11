// Fold-indent probe: renders a finished turn's nested folds (whole-process
// row → work cluster → thinking row + reply sentence) in the real Chromium
// layout engine across four indent variants, so "the process is squeezed by a
// second guide line / a fully flush body looks stuck to the edge" is settled
// with numbers and one picture. Variants: a = the old 22 px + line, b = 0 px,
// c = 8 px, d = 12 px — the three line-free ones sit on top of the main
// stylesheet, which already drops the line and the indent.
//
//   npx electron scripts/fold-probe.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel.css'), 'utf8')

const CHEVRON = '<svg class="panel-cluster-chevron" viewBox="0 0 20 20"></svg>'
const SPARK = '<svg class="panel-thought-icon" viewBox="0 0 20 20"></svg>'

const COLUMN = (id) => `
<div class="panel-bubble" id="${id}">
  <div class="panel-workspace">
    <div class="panel-feed-wrap">
      <div class="panel-feed">
        <article class="panel-event panel-event-assistant is-run">
          <div class="panel-event-avatar" aria-hidden="true"><span class="panel-event-glyph">鲸</span><time class="panel-event-time">16:23</time></div>
          <div class="panel-event-body">
            <details class="panel-cluster is-turn-process" open>
              <summary class="panel-cluster-summary">${CHEVRON}<span class="panel-cluster-facts"><span>用时 03:55</span></span><span class="panel-cluster-state" aria-hidden="true">✓</span></summary>
              <div class="panel-cluster-body">
                <details class="panel-cluster" open>
                  <summary class="panel-cluster-summary">${CHEVRON}<span class="panel-cluster-facts"><span>用时 00:11</span></span><span class="panel-cluster-state" aria-hidden="true">✓</span></summary>
                  <div class="panel-cluster-body">
                    <details class="panel-thought" open>
                      <summary>${SPARK}<span class="panel-thought-label">已思考</span><span class="panel-thought-time">11 秒</span><span class="panel-thought-state" aria-hidden="true">✓</span></summary>
                      <div class="panel-markdown"><p>先读屏幕左边的解析，确认公式和参数。</p></div>
                    </details>
                    <div class="panel-run-item"><p>好——这个是「用计算器实操」的演示任务：先把屏幕左边的解析读出公式，再打开计算器一步步按出来。</p></div>
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
${['a', 'b', 'c', 'd'].map(COLUMN).join('\n')}
</body></html>`

// Sandbox-only overrides: four fixed-width columns on one grid, content
// laid out eagerly, and the three alternative indent treatments.
const SANDBOX = `
  html, body { margin: 0; background: #0c1b3e; }
  body { display: grid; grid-template-columns: repeat(2, 534px); gap: 16px; padding: 16px; }
  .panel-bubble { position: static; width: 534px; height: auto; max-height: none; }
  .panel-event, .panel-thought { content-visibility: visible; }
  .panel-feed { overflow: visible; }
  #a .panel-cluster.is-turn-process > .panel-cluster-body { padding-left: 22px; }
  #a .panel-cluster.is-turn-process > .panel-cluster-body::before { content: ""; position: absolute; left: 12px; top: -3px; bottom: -12px; width: 1px; background: rgba(150, 190, 255, .16); }
  #c .panel-cluster.is-turn-process > .panel-cluster-body { padding-left: 8px; }
  #d .panel-cluster.is-turn-process > .panel-cluster-body { padding-left: 12px; }
`

const MEASURE = `(() => {
  const out = {}
  for (const id of ['a', 'b', 'c', 'd']) {
    const col = document.getElementById(id)
    const base = col.querySelector('.panel-event-body').getBoundingClientRect().x
    const x = (el) => el ? +(el.getBoundingClientRect().x - base).toFixed(1) : null
    const processBody = col.querySelector('.is-turn-process > .panel-cluster-body')
    out[id] = {
      processChevron: x(col.querySelector('.is-turn-process > .panel-cluster-summary .panel-cluster-chevron')),
      clusterChevron: x(col.querySelector('.panel-cluster-body > .panel-cluster > .panel-cluster-summary .panel-cluster-chevron')),
      thoughtSummary: x(col.querySelector('.panel-thought summary')),
      runItem: x(col.querySelector('.panel-run-item p')),
      processPad: getComputedStyle(processBody).paddingLeft,
      line: getComputedStyle(processBody, '::before').content,
    }
  }
  return JSON.stringify(out)
})()`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1120, height: 1000, show: false })
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HTML))
  await win.webContents.insertCSS(CSS)
  await win.webContents.insertCSS(SANDBOX)
  await sleep(300)
  const result = await win.webContents.executeJavaScript(MEASURE)
  const shot = path.join(os.tmpdir(), 'fold-probe.png')
  writeFileSync(shot, (await win.capturePage()).toPNG())
  console.log('MEASURED ' + result)
  console.log('shot: ' + shot)
  app.exit(0)
})
