// Ahoge check: renders the real DOM stack (body + layer, same grid cell and
// contain geometry as the avatar window) next to the original artwork, plus
// one frame swung to −15° — a visual regression that the CSS integration is
// pixel-true and the root hinges cleanly.
//
//   npx electron scripts/ahoge-check.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT_DIR = path.join(__dirname, '..')
const OUT = path.join(os.tmpdir(), 'ahoge-stack.png')
const HTML_PATH = path.join(os.tmpdir(), 'ahoge-check.html')
const fileUrl = (rel) => 'file:///' + path.join(ROOT_DIR, rel).replace(/\\/g, '/')
const REF = fileUrl('src/renderer/assets/whale-girl-reference-cutout.png')
const BODY = fileUrl('src/renderer/assets/whale-girl-ahoge-body.png')
const LAYER = fileUrl('src/renderer/assets/whale-girl-ahoge-layer.png')

const CELL = (inner) => `<div style="width:220px;height:280px;display:grid;place-items:center">${inner}</div>`
const IMG = (src, id) => `<img ${id ? `id="${id}"` : ''} src="${src}" style="grid-area:1/1;width:100%;height:100%;object-fit:contain" draggable="false">`

const HTML = `<html><body style="margin:0;padding:8px;display:flex;gap:10px;background:#2b2b33">
  ${CELL(IMG(REF))}
  ${CELL(IMG(BODY) + IMG(LAYER, 'a0'))}
  ${CELL(IMG(BODY) + IMG(LAYER, 'a1'))}
</body></html>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 740, height: 312, show: false })
  writeFileSync(HTML_PATH, HTML)
  await win.loadFile(HTML_PATH)
  // Third cell: the swing frame, origin mapped exactly like playAhogeFlick.
  await win.webContents.executeJavaScript(`(() => {
    const el = document.getElementById('a1')
    const r = el.getBoundingClientRect()
    const s = Math.min(r.width, r.height)
    const ox = (r.width - s) / 2 + (636 / 1254) * s
    const oy = (r.height - s) / 2 + (118 / 1254) * s
    el.style.transformOrigin = ox + 'px ' + oy + 'px'
    el.style.transform = 'rotate(-15deg)'
    return [r.width, r.height]
  })()`).then((box) => console.log('cell box: ' + JSON.stringify(box)))
  await new Promise((resolve) => setTimeout(resolve, 400))
  const image = await win.webContents.capturePage()
  writeFileSync(OUT, image.toPNG())
  console.log('stack: ' + OUT)
  app.exit(0)
}).catch((error) => { console.error('CHECK_ERROR: ' + error.message); app.exit(1) })
