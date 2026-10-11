// Ahoge cut: splits the base portrait into "body without ahoge" and a
// full-size transparent ahoge layer that can be animated on its own. Both
// outputs share the base's 1254×1254 canvas, so the layer dropped back in at
// rest reproduces the original artwork, and rotating the layer around the
// root moves only the ahoge.
//
// The ahoge is polygon-traced by hand (auto colour/connectivity split trips
// over the white lace whose outline is the same dark blue as the ahoge's).
// A ring around the root stays on the body so no hole opens up when the
// layer swings.
//
//   npx electron scripts/ahoge-cut.cjs --probe    (polygon overlay, 2× crop)
//   npx electron scripts/ahoge-cut.cjs --preview  (three swung angles)
//   npx electron scripts/ahoge-cut.cjs            (write body + layer)
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT_DIR = path.join(__dirname, '..')
const BASE = path.join(ROOT_DIR, 'src', 'renderer', 'assets', 'whale-girl-reference-cutout.png')
const OUT_BODY = path.join(ROOT_DIR, 'src', 'renderer', 'assets', 'whale-girl-ahoge-body.png')
const OUT_LAYER = path.join(ROOT_DIR, 'src', 'renderer', 'assets', 'whale-girl-ahoge-layer.png')
const PROBE = path.join(os.tmpdir(), 'ahoge-probe.png')
const PREVIEW = path.join(os.tmpdir(), 'ahoge-preview.png')

// Traced on the 1254×1254 canvas (values read off a 2× crop, x 250..850).
const POLYGON = [
  [411, 132], [422, 115], [445, 98], [465, 75], [487, 58], [510, 44],
  [535, 34], [559, 30], [584, 34], [605, 45], [627, 62], [645, 82],
  [665, 107], [675, 120], [660, 134], [600, 140], [570, 144], [540, 146],
  [510, 145], [480, 141], [455, 136], [430, 132]
]
// Swing axis: middle of the attachment where the ahoge meets the crown.
const ROOT = [636, 118]
const KEEP_R = 30

const mode = process.argv.includes('--probe') ? 'probe'
  : process.argv.includes('--preview') ? 'preview' : 'real'

const SHARED = `
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const orig = document.createElement('canvas')
  orig.width = w
  orig.height = h
  const octx = orig.getContext('2d')
  octx.drawImage(img, 0, 0)
  const full = octx.getImageData(0, 0, w, h)
  const inPoly = (x, y) => {
    let inside = false
    for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
      const [xi, yi] = POLY[i]
      const [xj, yj] = POLY[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const build = (keepRoot) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const im = ctx.getImageData(0, 0, w, h)
    const d = im.data
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (d[i + 3] === 0 || !inPoly(x, y)) continue
        if (keepRoot && Math.hypot(x - ROOT[0], y - ROOT[1]) < KEEP) continue
        d[i] = 0; d[i + 1] = 0; d[i + 2] = 0; d[i + 3] = 0
      }
    }
    ctx.putImageData(im, 0, 0)
    return c
  }
  // Layer: everything the polygon encloses, unchanged.
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lctx = layer.getContext('2d')
  lctx.drawImage(img, 0, 0)
  const lim = lctx.getImageData(0, 0, w, h)
  const ld = lim.data
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (inPoly(x, y)) continue
      ld[(y * w + x) * 4 + 3] = 0
    }
  }
  lctx.putImageData(lim, 0, 0)
`

const PROBE_RUN = `(async (dataUrl, POLY, ROOT) => {${SHARED}
  const out = document.createElement('canvas')
  out.width = 1200
  out.height = 680
  const octx2 = out.getContext('2d')
  octx2.imageSmoothingQuality = 'high'
  octx2.drawImage(img, 0, 0)
  // 2× crop of x 250..850, y 0..340 — same framing as the first probe.
  const c = document.createElement('canvas')
  c.width = 1200
  c.height = 680
  const cctx = c.getContext('2d')
  cctx.imageSmoothingQuality = 'high'
  cctx.drawImage(img, 250, 0, 600, 340, 0, 0, 1200, 680)
  cctx.strokeStyle = 'rgba(255, 60, 60, 0.9)'
  cctx.lineWidth = 2
  cctx.beginPath()
  POLY.forEach(([px, py], i) => {
    const dx = (px - 250) * 2
    const dy = py * 2
    if (i === 0) cctx.moveTo(dx, dy); else cctx.lineTo(dx, dy)
  })
  cctx.closePath()
  cctx.stroke()
  cctx.beginPath()
  cctx.arc((ROOT[0] - 250) * 2, ROOT[1] * 2, 60, 0, Math.PI * 2)
  cctx.strokeStyle = 'rgba(60, 220, 80, 0.9)'
  cctx.stroke()
  return c.toDataURL('image/png')
})`

const PREVIEW_RUN = `(async (dataUrl, POLY, ROOT, KEEP, angles) => {${SHARED}
  const body = build(true)
  const swung = angles.map((deg) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(body, 0, 0)
    ctx.save()
    ctx.translate(ROOT[0], ROOT[1])
    ctx.rotate(deg * Math.PI / 180)
    ctx.translate(-ROOT[0], -ROOT[1])
    ctx.drawImage(layer, 0, 0)
    ctx.restore()
    return c
  })
  const out = document.createElement('canvas')
  out.width = 500 * swung.length
  out.height = 500
  const octx2 = out.getContext('2d')
  octx2.fillStyle = '#3a3a46'
  octx2.fillRect(0, 0, out.width, out.height)
  swung.forEach((c, i) => octx2.drawImage(c, 60, 20, 1140, 1140, i * 500, 0, 500, 500))
  return out.toDataURL('image/png')
})`

const REAL_RUN = `(async (dataUrl, POLY, ROOT, KEEP) => {${SHARED}
  return JSON.stringify({ body: build(true).toDataURL('image/png'), layer: layer.toDataURL('image/png') })
})`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const dataUrl = 'data:image/png;base64,' + readFileSync(BASE).toString('base64')
  const run = (source) => Promise.race([
    win.webContents.executeJavaScript(source),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000))
  ])
  if (mode === 'probe') {
    const out = await run(`${PROBE_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)})`)
    writeFileSync(PROBE, Buffer.from(out.split(',')[1], 'base64'))
    console.log('probe: ' + PROBE)
  } else if (mode === 'preview') {
    const out = await run(`${PREVIEW_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)}, ${KEEP_R}, ${JSON.stringify([0, -16, 12])})`)
    writeFileSync(PREVIEW, Buffer.from(out.split(',')[1], 'base64'))
    console.log('preview: ' + PREVIEW)
  } else {
    const raw = await run(`${REAL_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)}, ${KEEP_R})`)
    const result = JSON.parse(raw)
    writeFileSync(OUT_BODY, Buffer.from(result.body.split(',')[1], 'base64'))
    writeFileSync(OUT_LAYER, Buffer.from(result.layer.split(',')[1], 'base64'))
    console.log('body:  ' + OUT_BODY)
    console.log('layer: ' + OUT_LAYER)
  }
  app.exit(0)
}).catch((error) => { console.error('AHOGE_ERROR: ' + error.message); app.exit(1) })
