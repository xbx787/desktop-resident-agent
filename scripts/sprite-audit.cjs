// Sprite audit: measures, for every staged sprite, its alpha bounding box,
// fill ratio, edge dirt and dark-pixel load — so the normalizer's common
// scale and baseline can be set from data instead of guesswork. Also doubles
// as the quality gate for the generated batches (dark blobs left by the
// cut-out, junk pixels hugging the canvas edge).
//
//   npx electron scripts/sprite-audit.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync } = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const POSES = [
  ['wave', '蓝发波浪发女仆贴纸少女.png'],
  ['doze', '蓝发鲸尾女仆的午睡贴纸.png'],
  ['cheer', '跃起欢呼的蓝发海兽女仆.png'],
  ['dozy', '困倦打哈欠的蓝发女仆少女.png'],
  ['smile', 'ChatGPT_图像_2026年10月11日_00_01_40-1.png'],
  ['surprise', 'ChatGPT_图像_2026年10月11日_00_01_41-2.png'],
  ['focus', 'ChatGPT_图像_2026年10月11日_00_01_43-3.png'],
  ['sleepy', 'ChatGPT_图像_2026年10月11日_00_01_45-4.png'],
  ['shy', 'ChatGPT_图像_2026年10月11日_00_01_46-5.png']
]
const CLIPS = [
  ['flick1-src', '左弯呆萌蓝发女仆少女.png'],
  ['flick2-src', '蓝发女仆的疾风呆毛.png'],
  ['flick3-src', '蓝发无口少女女仆贴纸.png'],
  ['flick4-src', '蓝发女仆的飞扬发梢.png']
]
const FILES = [
  ['base', 'src/renderer/assets/whale-girl-reference-cutout.png'],
  ...POSES.map(([slug, file]) => [slug, 'data/avatar-staging/cutout/' + file]),
  ...CLIPS.map(([slug, file]) => [slug, 'data/avatar-staging/' + file]),
  ...['01', '02', '03', '04'].map((n) => ['clip' + n, 'src/renderer/assets/clips/ear-flick/' + n + '.png'])
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
  const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height)
  let minX = width, minY = height, maxX = -1, maxY = -1, op = 0, dark = 0, edge = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const a = data[i + 3]
      if (a <= 8) continue
      op++
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3
      if (a > 100 && lum < 50) dark++
      if (x < 4 || y < 4 || x >= width - 4 || y >= height - 4) edge++
    }
  }
  if (maxX < 0) return JSON.stringify({ empty: true })
  return JSON.stringify({
    size: width + 'x' + height,
    box: [minX, minY, maxX, maxY],
    wh: [maxX - minX + 1, maxY - minY + 1],
    rel: { x0: +(minX / width).toFixed(3), y0: +(minY / height).toFixed(3), x1: +(maxX / width).toFixed(3), y1: +(maxY / height).toFixed(3) },
    opPx: op,
    darkPx: dark,
    edgePx: edge
  })
})`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  const run = (source) => Promise.race([
    win.webContents.executeJavaScript(source),
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 60000))
  ])
  for (const [label, rel] of FILES) {
    const bytes = readFileSync(path.join(ROOT, rel))
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
    const raw = await run(`${RUN}(${JSON.stringify(dataUrl)})`)
    console.log(label.padEnd(11) + raw)
  }
  app.exit(0)
}).catch((error) => { console.error('AUDIT_ERROR: ' + error.message); app.exit(1) })
