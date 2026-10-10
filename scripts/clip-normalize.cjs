// Clip normalize: turns the four downloaded ear-flick frames into uniform
// 160×160 sprites under src/renderer/assets/clips/ear-flick/, exactly like
// pose-normalize does for the poses. Frames that already carry an alpha
// background are used as-is; frames with a solid corner colour (black, white)
// get that colour flooded out from the border first — with a tight tolerance
// so the sticker's dark outlines survive. Also writes a 4-frame preview strip
// to %TEMP% so the animation can be eyeballed.
//
//   npx electron scripts/clip-normalize.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'data', 'avatar-staging')
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'clips', 'ear-flick')
const PREVIEW = path.join(os.tmpdir(), 'ear-flick-preview.png')
const SIZE = 160
const PAD = 6

const MAP = [
  ['左弯呆萌蓝发女仆少女.png', '01'],
  ['蓝发女仆的疾风呆毛.png', '02'],
  ['蓝发无口少女女仆贴纸.png', '03'],
  ['蓝发女仆的飞扬发梢.png', '04']
]

const RUN = `(async (dataUrl) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.naturalWidth
  c.height = img.naturalHeight
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  const im = ctx.getImageData(0, 0, c.width, c.height)
  const { data, width, height } = im
  const px = (x, y) => { const i = (y * width + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]] }
  const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)]
  const opaque = corners.filter((corner) => corner[3] > 10)
  let bg = null
  if (opaque.length >= 2) {
    const [r, g, b] = opaque[0]
    if (opaque.every((corner) => Math.abs(corner[0] - r) < 24 && Math.abs(corner[1] - g) < 24 && Math.abs(corner[2] - b) < 24)) bg = [r, g, b]
  }
  // A corner test can come up empty while the image still hides a baked-in
  // checkerboard — exports that "show" transparency as real grey/white
  // squares. Detect the pattern along the top row (always backdrop: grey and
  // white squares alternate at a fixed period) and flood it out with a
  // periodicity test. White cloth and sticker outlines are flat runs, never
  // periodic, so they survive the flood.
  let mode = null
  if (bg) mode = 'flood'
  else {
    // Learn the backdrop's two tones from the top row's histogram instead of
    // measuring the period: the squares stay near two luminance peaks (the
    // export's grey is ~130/~193, not the 255 white of cloth), while sticker
    // whites and coloured pixels sit far off both peaks.
    const hist = new Uint32Array(256)
    let counted = 0
    for (let x = 0; x < width; x++) {
      const i = x * 4
      if (data[i + 3] < 200) continue
      hist[Math.round((data[i] + data[i + 1] + data[i + 2]) / 3)]++
      counted++
    }
    if (counted > width * 0.8) {
      // Smooth before peaking: compression dithering splits one tone across a
      // dozen bins, so the peak test runs on the smoothed histogram while the
      // mass test below widens each peak's window.
      const smooth = new Uint32Array(256)
      for (let v = 0; v < 256; v++) {
        let s = 0
        for (let w = Math.max(0, v - 2); w <= Math.min(255, v + 2); w++) s += hist[w]
        smooth[v] = s
      }
      let p1 = 0
      for (let v = 0; v < 256; v++) if (smooth[v] > smooth[p1]) p1 = v
      let p2 = -1
      for (let v = 0; v < 256; v++) {
        if (Math.abs(v - p1) <= 25) continue
        if (p2 < 0 || smooth[v] > smooth[p2]) p2 = v
      }
      if (p2 >= 0 && Math.abs(p1 - p2) >= 25) {
        const mass = (c) => {
          let s = 0
          for (let v = Math.max(0, c - 22); v <= Math.min(255, c + 22); v++) s += hist[v]
          return s
        }
        if (mass(p1) > counted * 0.2 && mass(p2) > counted * 0.2) {
          mode = 'checker'
        }
      }
    }
  }
  if (mode) {
    const [br, bc, bb] = bg ?? [0, 0, 0]
    const isFlood = (p) => Math.abs(data[p * 4] - br) < 36 && Math.abs(data[p * 4 + 1] - bc) < 36 && Math.abs(data[p * 4 + 2] - bb) < 36 && data[p * 4 + 3] > 0
    const isChecker = (p) => {
      const i = p * 4
      // Low alpha floor on purpose: the export's outermost ring is faintly
      // transparent (anti-aliased or dirty), and a strict 200 floor left a
      // one-pixel frame around the whole canvas that kept the bounding box
      // at full size.
      if (data[i + 3] < 30) return false
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      if (Math.max(r, g, b) - Math.min(r, g, b) > 30) return false
      const l = (r + g + b) / 3
      // Any mid grey, not just the two sampled tones: one corner of this
      // export carries a second, denser checkerboard whose greys drift off
      // both histogram peaks. Sticker whites (250+) and the ink outline
      // (under 60) sit outside the window, and together they seal the
      // subject off from the flood.
      return l >= 60 && l <= 235
    }
    const test = mode === 'checker' ? isChecker : isFlood
    const stack = []
    const push = (x, y) => { if (x >= 0 && y >= 0 && x < width && y < height) stack.push(y * width + x) }
    for (let x = 0; x < width; x++) { push(x, 0); push(x, height - 1) }
    for (let y = 0; y < height; y++) { push(0, y); push(width - 1, y) }
    while (stack.length) {
      const p = stack.pop()
      if (data[p * 4 + 3] === 0) continue
      const x = p % width
      const y = (p - x) / width
      if (!test(p, x, y)) continue
      data[p * 4 + 3] = 0
      push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1)
    }
    if (mode === 'checker') {
      // Safety band: stray anti-aliased remnants along the canvas edge match
      // no colour test (that is why they survived the flood). Whatever they
      // are, they are not artwork — in these exports the subject never comes
      // within 30 px of the edge, so a 4 px frame is unconditionally clear.
      const band = 4
      for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
          if (x >= band && x < width - band && y >= band && y < height - band) continue
          data[(row + x) * 4 + 3] = 0
        }
      }
    }
    ctx.putImageData(im, 0, 0)
  }
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return JSON.stringify({ ok: false })
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const scale = Math.min((${SIZE} - ${PAD} * 2) / bw, (${SIZE} - ${PAD} * 2) / bh)
  const dw = Math.max(1, Math.round(bw * scale))
  const dh = Math.max(1, Math.round(bh * scale))
  const out = document.createElement('canvas')
  out.width = ${SIZE}
  out.height = ${SIZE}
  const octx = out.getContext('2d')
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(c, minX, minY, bw, bh, Math.round((${SIZE} - dw) / 2), ${SIZE} - ${PAD} - dh, dw, dh)
  return JSON.stringify({ ok: true, bg: bg, mode: mode, box: [bw, bh], png: out.toDataURL('image/png') })
})`

const PREVIEW_RUN = `(async (urls) => {
  const out = document.createElement('canvas')
  out.width = ${SIZE} * urls.length
  out.height = ${SIZE}
  const octx = out.getContext('2d')
  for (let i = 0; i < urls.length; i++) {
    const im = new Image()
    im.src = urls[i]
    await im.decode()
    octx.drawImage(im, i * ${SIZE}, 0)
  }
  return out.toDataURL('image/png')
})`

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  // executeJavaScript with megabyte-scale strings occasionally wedges the
  // renderer's IPC; a per-frame timeout turns that hang into a clean failure
  // instead of a script that never exits.
  const run = (source, label) => Promise.race([
    win.webContents.executeJavaScript(source),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout: ' + label)), 60000))
  ])
  const outputs = []
  for (const [file, n] of MAP) {
    const bytes = readFileSync(path.join(SRC, file))
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
    const raw = await run(`${RUN}(${JSON.stringify(dataUrl)})`, file)
    const result = JSON.parse(raw)
    if (!result.ok) { console.log('skip (empty): ' + file); continue }
    writeFileSync(path.join(OUT, n + '.png'), Buffer.from(result.png.split(',')[1], 'base64'))
    outputs.push(result.png)
    console.log(`clip: ${n}  <- ${file}  mode=${result.mode ?? 'none'}  bg=${result.bg ? result.bg.join(',') : '-'}  crop=${result.box.join('x')}`)
  }
  const preview = await run(`${PREVIEW_RUN}(${JSON.stringify(outputs)})`, 'preview')
  writeFileSync(PREVIEW, Buffer.from(preview.split(',')[1], 'base64'))
  console.log('preview: ' + PREVIEW)
  app.exit(0)
}).catch((error) => { console.error('CLIP_ERROR: ' + error.message); app.exit(1) })
