// Pose normalize: takes the cut-out generation batch and produces uniform
// 160×160 sprites — cropped to the alpha bounding box, scaled to fit inside a
// 148 px box, and anchored to a common bottom baseline so pose swaps do not
// make the character hop around. Output: src/renderer/assets/poses/.
//
//   npx electron scripts/pose-normalize.cjs
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs')
const path = require('node:path')

const SRC = path.join(__dirname, '..', 'data', 'avatar-staging', 'cutout')
const OUT = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'poses')
const SIZE = 160
const PAD = 6

const MAP = [
  ['蓝发波浪发女仆贴纸少女.png', 'wave'],
  ['蓝发鲸尾女仆的午睡贴纸.png', 'doze'],
  ['跃起欢呼的蓝发海兽女仆.png', 'cheer'],
  ['困倦打哈欠的蓝发女仆少女.png', 'dozy'],
  ['ChatGPT_图像_2026年10月11日_00_01_40-1.png', 'smile'],
  ['ChatGPT_图像_2026年10月11日_00_01_41-2.png', 'surprise'],
  ['ChatGPT_图像_2026年10月11日_00_01_43-3.png', 'focus'],
  ['ChatGPT_图像_2026年10月11日_00_01_45-4.png', 'sleepy'],
  ['ChatGPT_图像_2026年10月11日_00_01_46-5.png', 'shy']
]

const RUN = `(async (dataUrl, size, pad) => {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const src = document.createElement('canvas')
  src.width = img.naturalWidth
  src.height = img.naturalHeight
  const sctx = src.getContext('2d')
  sctx.drawImage(img, 0, 0)
  const { data, width, height } = sctx.getImageData(0, 0, src.width, src.height)
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
  if (maxX < 0) return null
  const bw = maxX - minX + 1
  const bh = maxY - minY + 1
  const scale = Math.min((size - pad * 2) / bw, (size - pad * 2) / bh)
  const dw = Math.max(1, Math.round(bw * scale))
  const dh = Math.max(1, Math.round(bh * scale))
  const out = document.createElement('canvas')
  out.width = size
  out.height = size
  const octx = out.getContext('2d')
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(src, minX, minY, bw, bh, Math.round((size - dw) / 2), size - pad - dh, dw, dh)
  return out.toDataURL('image/png')
})`

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

app.whenReady().then(async () => {
  mkdirSync(OUT, { recursive: true })
  const win = new BrowserWindow({ width: 300, height: 200, show: false })
  await win.loadURL('data:text/html,<html><body></body></html>')
  for (const [file, slug] of MAP) {
    const bytes = readFileSync(path.join(SRC, file))
    const dataUrl = 'data:image/png;base64,' + bytes.toString('base64')
    const out = await win.webContents.executeJavaScript(`${RUN}(${JSON.stringify(dataUrl)}, ${SIZE}, ${PAD})`)
    if (!out) { console.log('skip (empty): ' + file); continue }
    writeFileSync(path.join(OUT, slug + '.png'), Buffer.from(out.split(',')[1], 'base64'))
    console.log('norm: ' + slug + '  <- ' + file)
  }
  app.exit(0)
})
