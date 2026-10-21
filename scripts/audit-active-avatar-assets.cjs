// Checks the PNGs that avatar-rig.ts and avatar-poses.ts actually render.
// avatar-art.ts is a compatibility facade now; the rig is the source of truth.
// Unlike sprite-audit.cjs, this needs neither staging files nor Electron.
// Run before packaging: node scripts/audit-active-avatar-assets.cjs
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const ROOT = path.resolve(__dirname, '..')
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngAlphaMetricsFromBuffer(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('不是 PNG 文件')
  let offset = 8
  let width = 0
  let height = 0
  let headerSeen = false
  let endSeen = false
  const idats = []
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const next = offset + 12 + length
    if (next > bytes.length) throw new Error('PNG chunk 长度越界')
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length)
    const actualCrc = crc32(bytes.subarray(offset + 4, offset + 8 + length))
    if (expectedCrc !== actualCrc) throw new Error(`PNG ${type} 校验值错误`)
    if (type === 'IHDR') {
      if (headerSeen || length !== 13) throw new Error('PNG IHDR 无效')
      width = bytes.readUInt32BE(offset + 8)
      height = bytes.readUInt32BE(offset + 12)
      if (bytes[offset + 16] !== 8 || bytes[offset + 17] !== 6 || bytes[offset + 20] !== 0) {
        throw new Error('当前审计仅支持非隔行 8-bit RGBA PNG；请统一素材格式')
      }
      if (width < 1 || height < 1 || width * height > 20_000_000) throw new Error('PNG 尺寸无效或过大')
      headerSeen = true
    } else if (type === 'IDAT') {
      idats.push(bytes.subarray(offset + 8, offset + 8 + length))
    } else if (type === 'IEND') {
      endSeen = true
      break
    }
    offset = next
  }
  if (!headerSeen || !idats.length || !endSeen) throw new Error('PNG 缺少 IHDR、IDAT 或 IEND')

  const stride = width * 4
  const expected = height * (stride + 1)
  const raw = zlib.inflateSync(Buffer.concat(idats), { maxOutputLength: expected + 1 })
  if (raw.length !== expected) throw new Error('PNG 解压数据长度不符')
  let prev = Buffer.alloc(stride)
  let row = Buffer.alloc(stride)
  let pos = 0
  let pixels = 0
  let solidPixels = 0
  let edgePixels = 0
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]
    if (filter > 4) throw new Error(`PNG 扫描行过滤器无效：${filter}`)
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? row[i - 4] : 0
      const up = prev[i]
      const upperLeft = i >= 4 ? prev[i - 4] : 0
      let predictor = 0
      if (filter === 1) predictor = left
      else if (filter === 2) predictor = up
      else if (filter === 3) predictor = Math.floor((left + up) / 2)
      else if (filter === 4) {
        const p = left + up - upperLeft
        const a = Math.abs(p - left)
        const b = Math.abs(p - up)
        const c = Math.abs(p - upperLeft)
        predictor = a <= b && a <= c ? left : b <= c ? up : upperLeft
      }
      row[i] = (raw[pos++] + predictor) & 255
    }
    for (let x = 0; x < width; x++) {
      const alpha = row[x * 4 + 3]
      if (alpha <= 8) continue
      pixels++
      if (alpha >= 128) solidPixels++
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgePixels++
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)
    }
    ;[prev, row] = [row, prev]
  }
  const box = pixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null
  return { width, height, pixels, solidPixels, edgePixels, box,
    alphaRatio: pixels / (width * height),
    bottomMargin: box ? height - (box.y + box.height) : height }
}

function pngAlphaMetrics(file) {
  return pngAlphaMetricsFromBuffer(fs.readFileSync(file))
}

function assetInventory(root = ROOT) {
  const artFile = path.join(root, 'src', 'renderer', 'avatar-rig.ts')
  const posesFile = path.join(root, 'src', 'renderer', 'avatar-poses.ts')
  const personaFile = path.join(root, 'src', 'shared', 'personas.ts')
  const roleOf = (name) => name.includes('/personas/')
    ? name.endsWith('-avatar.png') ? 'persona-avatar' : 'persona-body'
    : name.includes('/poses/') ? 'pose'
    : name.includes('ahoge-layer') ? 'ahoge'
    : 'base-body'
  const refs = []
  for (const [source, roleOfAsset] of [[artFile, roleOf], [posesFile, () => 'pose']]) {
    const content = fs.readFileSync(source, 'utf8')
    for (const match of content.matchAll(/new URL\(['"](\.\/assets\/[^'"]+\.png)['"],\s*import\.meta\.url\)/g)) {
      const rel = match[1]
      refs.push({ name: path.basename(rel), file: path.resolve(path.dirname(source), rel), role: roleOfAsset(rel) })
    }
  }
  // The rig and the pose legacy table intentionally point at the same PNGs.
  // One real file may back several references as long as its role agrees.
  const unique = new Map()
  for (const ref of refs) {
    const previous = unique.get(ref.file)
    if (previous && previous.role !== ref.role) throw new Error(`${ref.name}: 同一素材承担了不同角色（${previous.role} / ${ref.role}）`)
    if (!previous) unique.set(ref.file, ref)
  }
  refs.length = 0
  refs.push(...unique.values())
  const ids = [...fs.readFileSync(personaFile, 'utf8').matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]).filter((id) => id !== 'xiaojing')
  if (refs.filter((r) => r.role === 'base-body').length !== 1 || refs.filter((r) => r.role === 'ahoge').length > 1) {
    throw new Error('默认身体缺失或配置了多层呆毛；检查 avatar-rig.ts')
  }
  if (refs.filter((r) => r.role === 'pose').length < 1) throw new Error('未发现实际使用的姿势图；检查 avatar-poses.ts')
  for (const id of ids) {
    if (refs.filter((r) => r.role === 'persona-body' && r.name === `whale-persona-${id}-body.png`).length !== 1) {
      throw new Error(`${id} 的 persona-body 与 src/shared/personas.ts 不匹配`)
    }
  }
  for (const avatar of refs.filter((r) => r.role === 'persona-avatar')) {
    const id = /^whale-persona-(.+)-avatar\.png$/.exec(avatar.name)?.[1]
    if (!id || !ids.includes(id)) throw new Error(`${avatar.name}: 头像没有对应的人设预设`)
  }
  // A persona may reuse its body PNG in the chat avatar. Only separately
  // configured avatar URLs need an additional file and 256px square check.
  refs.push({ name: 'whale-girl-reference-cutout.png', file: path.join(root, 'src', 'renderer', 'assets', 'whale-girl-reference-cutout.png'), role: 'reference' })
  return refs
}

function validateMetrics(asset, metrics) {
  const failures = []
  const { role, name } = asset
  if (!metrics.box || metrics.solidPixels < (role === 'ahoge' ? 100 : 500)) {
    failures.push(`${name}: 几乎没有可见 alpha 内容（实色像素 ${metrics.solidPixels}）；请重新导出透明素材`)
    return failures
  }
  const { width, height, box } = metrics
  if (role === 'ahoge') {
    if (box.width < 30 || box.height < 12) failures.push(`${name}: 呆毛可见范围只有 ${box.width}×${box.height}px；疑似 1 像素空层或抠图失败`)
  } else if (role === 'persona-avatar') {
    if (width !== 256 || height !== 256) failures.push(`${name}: 头像画布 ${width}×${height}，应统一为 256×256`)
    if (box.width < 64 || box.height < 64) failures.push(`${name}: 头像主体过小（${box.width}×${box.height}）`)
  } else if (role === 'pose') {
    if (width < 512 || height < 512) failures.push(`${name}: 姿势图画布 ${width}×${height} 太小；动画切换会变模糊`)
    if (box.width < 160 || box.height < 160) failures.push(`${name}: 姿势图可见内容过小（${box.width}×${box.height}）`)
  } else {
    if (width < 200 || height < 300 || box.width < 150 || box.height < 200) {
      failures.push(`${name}: 立绘尺寸或可见主体过小（画布 ${width}×${height}，主体 ${box.width}×${box.height}）`)
    }
  }
  if (role !== 'ahoge' && metrics.alphaRatio > .95) failures.push(`${name}: 画布 ${Math.round(metrics.alphaRatio * 100)}% 有内容；可能保留了不透明背景`)
  return failures
}

function anchorGeometryFailures(source, body, layer) {
  const failures = []
  // The current implementation stores pixel coordinates as fractions. A
  // legacy denominator silently moves the pivot when the artwork is cropped.
  const canvas = /AHOGE_CANVAS\s*=\s*\{\s*width:\s*(\d+)\s*,\s*height:\s*(\d+)\s*\}/.exec(source)
  if (canvas && (+canvas[1] !== body.width || +canvas[2] !== body.height)) {
    failures.push(`avatar-ahoge.ts: AHOGE_CANVAS 为 ${canvas[1]}×${canvas[2]}，实际身体是 ${body.width}×${body.height}；请同步更新画布和发根`)
  }
  const namedRoot = /AHOGE_ROOT\s*=\s*\{\s*x:\s*(\d+)\s*\/\s*AHOGE_CANVAS\.width\s*,\s*y:\s*(\d+)\s*\/\s*AHOGE_CANVAS\.height\s*\}/.exec(source)
  const legacyRoot = /AHOGE_ROOT\s*=\s*\{\s*x:\s*(\d+)\s*\/\s*(\d+)\s*,\s*y:\s*(\d+)\s*\/\s*(\d+)\s*\}/.exec(source)
  let px
  let py
  if (namedRoot) {
    px = +namedRoot[1]
    py = +namedRoot[2]
  } else if (legacyRoot) {
    const [, x, sourceWidth, y, sourceHeight] = legacyRoot.map(Number)
    if (sourceWidth !== body.width || sourceHeight !== body.height) {
      failures.push(`avatar-ahoge.ts: 发根仍使用 ${sourceWidth}×${sourceHeight} 旧画布；实际身体是 ${body.width}×${body.height}，请按新画布重测 AHOGE_ROOT`)
    }
    px = x / sourceWidth * body.width
    py = y / sourceHeight * body.height
  }
  if (Number.isFinite(px) && Number.isFinite(py) && layer?.box && layer.box.width >= 30 && layer.box.height >= 12) {
    const b = layer.box
    if (px < b.x - 20 || px > b.x + b.width + 20 || py < b.y - 20 || py > b.y + b.height + 20) {
      failures.push(`avatar-ahoge.ts: 发根 (${Math.round(px)},${Math.round(py)}) 与呆毛 alpha 范围相距过远；请重设旋转轴`)
    }
  }
  if (body.width !== body.height && /Math\.min\(rect\.width,\s*rect\.height\)/.test(source)) {
    failures.push(`avatar-ahoge.ts: ahogeOrigin 仍按正方形 contain 映射，但实际画布 ${body.width}×${body.height}；请按矩形图像映射`)
  }
  return failures
}

function audit(root = ROOT) {
  const assets = assetInventory(root)
  const failures = []
  const results = []
  for (const asset of assets) {
    try {
      const metrics = pngAlphaMetrics(asset.file)
      results.push({ ...asset, metrics })
      failures.push(...validateMetrics(asset, metrics))
    } catch (error) {
      failures.push(`${asset.name}: ${error.message}`)
    }
  }
  const body = results.find((r) => r.role === 'base-body')
  const ahoge = results.find((r) => r.role === 'ahoge')
  const reference = results.find((r) => r.role === 'reference')
  if (body && ahoge && (body.metrics.width !== ahoge.metrics.width || body.metrics.height !== ahoge.metrics.height)) {
    failures.push(`默认身体与呆毛层画布尺寸不一致（${body.metrics.width}×${body.metrics.height} / ${ahoge.metrics.width}×${ahoge.metrics.height}），叠图会错位`)
  }
  if (body && ahoge) {
    const anchorSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'avatar-ahoge.ts'), 'utf8')
    failures.push(...anchorGeometryFailures(anchorSource, body.metrics, ahoge.metrics))
  }
  if (body && ahoge && reference && body.metrics.pixels === reference.metrics.pixels &&
      body.metrics.solidPixels === reference.metrics.solidPixels && body.metrics.box?.width === reference.metrics.box?.width &&
      body.metrics.box?.height === reference.metrics.box?.height) {
    failures.push('默认 body 与完整参考图的 alpha 轮廓、像素量完全相同；疑似只裁边而未移除静态呆毛，请核对拆层')
  }
  // Pose sprites are cropped at their alpha edges by avatarDisplaySize. Their
  // widths can differ (lying down vs standing), but the baseline should not.
  const poses = results.filter((r) => r.role === 'pose')
  const margins = poses.map((r) => r.metrics.bottomMargin / r.metrics.height)
  if (margins.length > 1 && Math.max(...margins) - Math.min(...margins) > .06) {
    failures.push(`姿势图底部留白差异达 ${Math.round((Math.max(...margins) - Math.min(...margins)) * 100)}%；切换时人物可能上下跳动，请统一底部锚点`)
  }
  return { results, failures }
}

if (require.main === module) {
  try {
    const { results, failures } = audit()
    for (const r of results) {
      const m = r.metrics
      console.log(`${r.role.padEnd(14)} ${r.name.padEnd(38)} ${m.width}×${m.height} alpha=${m.pixels} solid=${m.solidPixels} box=${m.box ? `${m.box.width}×${m.box.height}@${m.box.x},${m.box.y}` : 'empty'} bottom=${m.bottomMargin}`)
    }
    if (failures.length) {
      for (const failure of failures) console.error('ASSET_ERROR: ' + failure)
      process.exitCode = 1
    } else console.log(`Avatar asset audit passed: ${results.length} active PNGs`)
  } catch (error) {
    console.error('ASSET_ERROR: ' + error.message)
    process.exitCode = 1
  }
}

module.exports = { crc32, pngAlphaMetrics, pngAlphaMetricsFromBuffer, assetInventory, validateMetrics, anchorGeometryFailures, audit }
