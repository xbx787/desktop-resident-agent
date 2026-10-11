// Ahoge cut: splits the base portrait into "body without ahoge" and a
// full-size transparent ahoge layer that can be animated on its own. Both
// outputs share the base's 1254×1254 canvas, so the layer dropped back in at
// rest reproduces the original artwork, and rotating the layer around the
// root moves only the ahoge.
//
// The polygon is traced by hand and padded ~6 px past the outline: an
// earlier tight trace left slivers of the stroke behind, which rotated into
// view as dark edges. The whole ahoge — root included — leaves the body;
// the erased root area is then regrown from the boundary colours of the
// crown it used to cover (bounded colour diffusion), so a swing reveals a
// plausible hat, not a hole or a cut-off stub.
//
//   npx electron scripts/ahoge-cut.cjs --probe    (polygon overlay, 2× crop)
//   npx electron scripts/ahoge-cut.cjs --preview  (swing angles + root zoom)
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
const ZOOM = path.join(os.tmpdir(), 'ahoge-root-zoom.png')

// Traced on the 1254×1254 canvas (values read off a 2× crop, x 250..850),
// padded outward so the full stroke rides inside the layer.
const POLYGON = [
  [405, 129], [417, 107], [439, 89], [459, 67], [481, 50], [504, 36],
  [529, 26], [555, 22], [580, 26], [601, 37], [623, 54], [647, 77],
  [671, 105], [681, 119], [665, 137], [603, 146], [573, 150], [543, 152],
  [513, 151], [483, 147], [458, 142], [432, 137]
]
// Swing axis: middle of the attachment where the ahoge meets the crown.
const ROOT = [636, 118]
// How far the crown colour may creep back into the erased root area (px).
const REGROW_ROUNDS = 16

const mode = process.argv.includes('--probe') ? 'probe'
  : process.argv.includes('--preview') ? 'preview' : 'real'

const SHARED = `
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const w = img.naturalWidth
  const h = img.naturalHeight
  const inPoly = (x, y) => {
    let inside = false
    for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
      const [xi, yi] = POLY[i]
      const [xj, yj] = POLY[j]
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
    }
    return inside
  }
  const layer = document.createElement('canvas')
  layer.width = w
  layer.height = h
  const lctx = layer.getContext('2d')
  const build = () => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const im = ctx.getImageData(0, 0, w, h)
    const d = im.data
    // Pass 1: partition — ahoge pixels to erase, crown pixels to keep as the
    // diffusion source. A hand-traced outline, however carefully padded,
    // always leaves a few pixels of the stroke's anti-aliased fringe behind,
    // and those leftovers rotated into view as dark debris. So the mask is a
    // flood fill over the artwork's actual pixels, seeded inside the ahoge:
    // every fringe pixel joins the mask exactly as drawn. The polygon is
    // demoted to a guardrail — the fill may not wander more than 36 px from
    // it — which keeps the flood from escaping through the root into the
    // crown. The guard distance is precomputed over the outline's bounding
    // box as a lookup map.
    const GUARD = 36
    const bx0 = Math.max(0, Math.min(...POLY.map((q) => q[0])) - GUARD - 4)
    const by0 = Math.max(0, Math.min(...POLY.map((q) => q[1])) - GUARD - 4)
    const bx1 = Math.min(w - 1, Math.max(...POLY.map((q) => q[0])) + GUARD + 4)
    const by1 = Math.min(h - 1, Math.max(...POLY.map((q) => q[1])) + GUARD + 4)
    const segDist = (px, py, x1, y1, x2, y2) => {
      const dx = x2 - x1
      const dy = y2 - y1
      const len = dx * dx + dy * dy
      const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len))
      return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
    }
    const bw = bx1 - bx0 + 1
    const bh = by1 - by0 + 1
    const guard = new Float32Array(bw * bh)
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let best = Infinity
        for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) {
          const dist = segDist(bx0 + x, by0 + y, POLY[j][0], POLY[j][1], POLY[i][0], POLY[i][1])
          if (dist < best) best = dist
        }
        guard[y * bw + x] = best
      }
    }
    const nearPoly = (x, y) => {
      if (x < bx0 || y < by0 || x > bx1 || y > by1) return false
      return guard[(y - by0) * bw + (x - bx0)] <= GUARD
    }
    const mask = new Uint8Array(w * h)
    const stack = new Int32Array(w * h)
    let sp = 0
    const seed = 90 * w + 500  // a spot deep inside the ahoge
    mask[seed] = 1
    stack[sp++] = seed
    while (sp > 0) {
      const p = stack[--sp]
      const x = p % w
      const y = (p - x) / w
      if (x > 0) { const q = p - 1; if (!mask[q] && d[q * 4 + 3] > 0 && nearPoly(x - 1, y)) { mask[q] = 1; stack[sp++] = q } }
      if (x < w - 1) { const q = p + 1; if (!mask[q] && d[q * 4 + 3] > 0 && nearPoly(x + 1, y)) { mask[q] = 1; stack[sp++] = q } }
      if (y > 0) { const q = p - w; if (!mask[q] && d[q * 4 + 3] > 0 && nearPoly(x, y - 1)) { mask[q] = 1; stack[sp++] = q } }
      if (y < h - 1) { const q = p + w; if (!mask[q] && d[q * 4 + 3] > 0 && nearPoly(x, y + 1)) { mask[q] = 1; stack[sp++] = q } }
    }
    const erased = mask
    const known = new Uint8Array(w * h)
    for (let p = 0; p < w * h; p++) {
      if (d[p * 4 + 3] > 0 && !mask[p]) known[p] = 1
    }
    for (let p = 0; p < w * h; p++) {
      if (!erased[p]) continue
      d[p * 4] = 0; d[p * 4 + 1] = 0; d[p * 4 + 2] = 0; d[p * 4 + 3] = 0
    }
    // Pass 2: bounded colour diffusion — each round lets the crown's edge
    // colours advance one pixel into the erased area. Distant ahoge space
    // stays transparent; only the root seam regrows a lookalike crown.
    let filled = new Uint8Array(w * h)
    for (let round = 0; round < ${REGROW_ROUNDS}; round++) {
      const newly = []
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const p = y * w + x
          if (!erased[p] || filled[p]) continue
          let rs = 0, gs = 0, bs = 0, n = 0
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const q = (y + dy) * w + (x + dx)
              if (known[q] || filled[q]) {
                rs += d[q * 4]; gs += d[q * 4 + 1]; bs += d[q * 4 + 2]; n++
              }
            }
          }
          if (n >= 2) newly.push([p, Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)])
        }
      }
      for (const [p, r, g, b] of newly) {
        d[p * 4] = r; d[p * 4 + 1] = g; d[p * 4 + 2] = b; d[p * 4 + 3] = 255
        filled[p] = 1
      }
      if (!newly.length) break
    }
    ctx.putImageData(im, 0, 0)
    // Layer: the ahoge exactly as drawn — the flood mask, nothing else.
    lctx.drawImage(img, 0, 0)
    const lim = lctx.getImageData(0, 0, w, h)
    const ld = lim.data
    for (let p = 0; p < w * h; p++) {
      if (!mask[p]) ld[p * 4 + 3] = 0
    }
    lctx.putImageData(lim, 0, 0)
    return c
  }
`

const PROBE_RUN = `(async (dataUrl, POLY, ROOT) => {${SHARED}
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

const PREVIEW_RUN = `(async (dataUrl, POLY, ROOT, angles) => {${SHARED}
  const body = build()
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
  const octx = out.getContext('2d')
  octx.fillStyle = '#3a3a46'
  octx.fillRect(0, 0, out.width, out.height)
  swung.forEach((c, i) => octx.drawImage(c, 60, 20, 1140, 1140, i * 500, 0, 500, 500))
  // Root zoom: the −16° swing's seam, 3×, so a stub or hole cannot hide.
  const zoom = document.createElement('canvas')
  zoom.width = 780
  zoom.height = 570
  const zctx = zoom.getContext('2d')
  zctx.imageSmoothingQuality = 'high'
  zctx.drawImage(swung[1], 450, 10, 260, 190, 0, 0, 780, 570)
  return JSON.stringify({ preview: out.toDataURL('image/png'), zoom: zoom.toDataURL('image/png') })
})`

const REAL_RUN = `(async (dataUrl, POLY, ROOT) => {${SHARED}
  return JSON.stringify({ body: build().toDataURL('image/png'), layer: layer.toDataURL('image/png') })
})`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const dataUrl = 'data:image/png;base64,' + readFileSync(BASE).toString('base64')
  const run = (source) => Promise.race([
    win.webContents.executeJavaScript(source),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000))
  ])
  if (mode === 'probe') {
    const out = await run(`${PROBE_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)})`)
    writeFileSync(PROBE, Buffer.from(out.split(',')[1], 'base64'))
    console.log('probe: ' + PROBE)
  } else if (mode === 'preview') {
    const raw = await run(`${PREVIEW_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)}, ${JSON.stringify([0, -16, 12])})`)
    const result = JSON.parse(raw)
    writeFileSync(PREVIEW, Buffer.from(result.preview.split(',')[1], 'base64'))
    writeFileSync(ZOOM, Buffer.from(result.zoom.split(',')[1], 'base64'))
    console.log('preview: ' + PREVIEW)
    console.log('zoom:    ' + ZOOM)
  } else {
    const raw = await run(`${REAL_RUN}(${JSON.stringify(dataUrl)}, ${JSON.stringify(POLYGON)}, ${JSON.stringify(ROOT)})`)
    const result = JSON.parse(raw)
    writeFileSync(OUT_BODY, Buffer.from(result.body.split(',')[1], 'base64'))
    writeFileSync(OUT_LAYER, Buffer.from(result.layer.split(',')[1], 'base64'))
    console.log('body:  ' + OUT_BODY)
    console.log('layer: ' + OUT_LAYER)
  }
  app.exit(0)
}).catch((error) => { console.error('AHOGE_ERROR: ' + error.message); app.exit(1) })
