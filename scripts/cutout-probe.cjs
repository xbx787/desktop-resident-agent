// Cutout probe: floods the white background of generated sticker art to
// transparent, in the real Chromium canvas. Works from the four corners so
// only white connected to the canvas edge is removed — the white stroke ring
// inside the sticker survives. Output goes to <dir>/cutout/.
//
//   npx electron scripts/cutout-probe.cjs data/avatar-staging
const { app, BrowserWindow } = require('electron')
const { readdirSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const dir = path.resolve(process.argv.find((a) => !a.startsWith('-') && a.endsWith('avatar-staging')) || path.join(__dirname, '..', 'data', 'avatar-staging'))
const outDir = path.join(dir, 'cutout')

// Remove whites connected to the border. A pixel counts as background when
// it is nearly white; the fuzz stays tight so the sticker's pale outline
// ring stops the flood instead of being eaten.
const RUN = `(async (dataUrl) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data, width, height } = image
  const isWhite = (i) => data[i] > 246 && data[i + 1] > 246 && data[i + 2] > 246 && data[i + 3] > 0
  const stack = []
  const push = (x, y) => { if (x >= 0 && y >= 0 && x < width && y < height) stack.push(y * width + x) }
  for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1) }
  for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y) }
  while (stack.length) {
    const p = stack.pop()
    const i = p * 4
    if (!isWhite(i)) continue
    data[i + 3] = 0
    const x = p % width
    const y = (p - x) / width
    push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
  }
  ctx.putImageData(image, 0, 0)
  return canvas.toDataURL('image/png')
})`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true })
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.png'))
  const win = new BrowserWindow({ width: 300, height: 200, show: false, webPreferences: { offscreen: false } })
  await win.loadURL('data:text/html,<html><body></body></html>')
  for (const file of files) {
    const bytes = readFileSync(path.join(dir, file))
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
    const out = await win.webContents.executeJavaScript(`${RUN}(${JSON.stringify(dataUrl)})`)
    writeFileSync(path.join(outDir, file), Buffer.from(out.split(',')[1], 'base64'))
    console.log('cut: ' + file)
  }
  app.exit(0)
})
