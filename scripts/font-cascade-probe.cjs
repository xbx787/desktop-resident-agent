// Font-cascade probe: renders every single-class `font-size` declaration in
// panel.css as both a <button> and a <div> inside a real Electron window and
// reports where the *computed* size disagrees with the declared one.
//
// Why this exists: `.panel-bubble button, .panel-bubble textarea { font:
// inherit }` (specificity 0,1,1) silently beats plain class declarations
// (0,1,0) on buttons. Seven buttons wrote `font-size: 10px` that never took
// effect — they fell through to the inherited baseline instead (16px before
// the baseline existed, 11px after). Static reading cannot catch this; only
// a real cascade can. Run after touching panel.css font rules:
//
//   npx electron scripts/font-cascade-probe.cjs
//
// Exits non-zero when any declaration is shadowed on its real element.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const CSS_PATH = path.join(__dirname, '..', 'src', 'renderer', 'panel.css')

// Classes verified (2026-10-10, against the tsx) to render on div/span/time/
// input — the probe's button column is a hypothetical for them and the div
// column is the real value. If one of these ever starts being used on a
// <button>, remove it here so the cascade check covers it again.
const NON_BUTTON_CLASSES = new Set([
  'panel-session-menu-heading', 'panel-queue-heading', 'panel-library-hint', 'panel-library-error',
  'panel-event-time', 'panel-thought-state', 'panel-tool-result', 'panel-cluster-state',
  'panel-markdown', 'panel-approval-symbol', 'panel-eyebrow', 'panel-risk',
  'panel-approval-description', 'panel-ask-tick', 'panel-ask-header', 'panel-ask-other',
  'panel-ask-review-title', 'panel-ask-review-q', 'panel-ask-review-a', 'panel-ask-review-empty',
  'panel-plan-header', 'panel-popover-heading', 'panel-goal-banner-meta', 'panel-effort-badge',
  'panel-context-tokens', 'panel-context-unknown', 'panel-attachment-chip', 'panel-attachment-error'
])

function collectDeclarations(css) {
  const flat = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@media[^{]*\{/g, '')
  const out = []
  for (const raw of flat.split('}')) {
    const match = raw.match(/^\s*([^{]+)\{/s)
    if (!match) continue
    const body = raw.slice(match[0].length)
    const size = body.match(/font-size:\s*([\d.]+)px(\s*!important)?/)
    if (!size) continue
    for (let sel of match[1].split(',')) {
      sel = sel.trim()
      if (/^\.[a-z0-9-]+$/i.test(sel)) out.push({ sel, px: `${size[1]}px`, important: Boolean(size[2]) })
    }
  }
  return out
}

function buildProbePage(decls) {
  const items = decls.map((d, i) =>
    `<button id="b${i}" class="${d.sel.slice(1)}">字</button><div id="d${i}" class="${d.sel.slice(1)}">字</div>`).join('\n')
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><link rel="stylesheet" href="${CSS_PATH.replace(/\\/g, '/')}"></head>
<body><div class="panel-bubble">
${items}
</div><pre id="probe"></pre>
<script>
const decls = ${JSON.stringify(decls)}
document.getElementById('probe').textContent = decls.map((d, i) => {
  const b = getComputedStyle(document.getElementById('b' + i)).fontSize
  const div = getComputedStyle(document.getElementById('d' + i)).fontSize
  return [d.sel, d.px, d.important, b, div].join('|')
}).join('\\n')
</script></body></html>`
}

app.whenReady().then(async () => {
  const decls = collectDeclarations(readFileSync(CSS_PATH, 'utf8'))
  const page = path.join(os.tmpdir(), `font-cascade-probe-${process.pid}.html`)
  writeFileSync(page, buildProbePage(decls))
  const win = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await win.loadFile(page)
  const rows = (await win.webContents.executeJavaScript('document.getElementById("probe").textContent'))
    .split('\n').map((line) => {
      const [sel, px, important, onButton, onDiv] = line.split('|')
      return { sel, px, important: important === 'true', onButton, onDiv }
    })
  const shadowed = rows.filter((r) => r.onButton !== r.px && !NON_BUTTON_CLASSES.has(r.sel.slice(1)))
  if (shadowed.length === 0) {
    console.log(`font-cascade-probe: OK — all ${rows.length} declarations render as declared.`)
  } else {
    console.log(`font-cascade-probe: ${shadowed.length} declaration(s) shadowed on <button>:`)
    for (const r of shadowed) console.log(`  ${r.sel}  declared ${r.px}${r.important ? '!' : ''}  rendered ${r.onButton}  (div: ${r.onDiv})`)
  }
  app.exit(shadowed.length === 0 ? 0 : 1)
})
