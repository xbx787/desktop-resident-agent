/**
 * 从 panel.css 生成亮色主题 panel-light.css。
 *
 * 做法：保留色相和饱和度，只把亮度翻转（L -> 1-L）。深底变浅底、浅字变深字，
 * 蓝色强调仍是蓝色，只是明度反过来。以下两类不参与翻转：
 *  - 状态色（完成/进行/失败/等待/空闲），两套主题共用同一组值；
 *  - 纯黑阴影，亮色主题下仍然是黑色阴影。
 *
 * 选择器统一加 `body.panel-theme-light` 前缀（`body.panel-window` 变成
 * `body.panel-window.panel-theme-light`），这样只在亮色 class 下生效。
 */
const fs = require('node:fs')
const path = require('node:path')

const source = path.join(__dirname, '..', 'src', 'renderer', 'panel.css')
const target = path.join(__dirname, '..', 'src', 'renderer', 'panel-light.css')

const STATUS_COLORS = new Set([
  '#80d6a1', '#f3c36f', '#f48790', '#b79cff', '#86b3f2', '#9db9e9',
  '#7bbaff', '#a9b5ce', '#a8e8bc', '#ffc2c6', '#f5d39b', '#f7c778',
  '#f4d8c2', '#e79a9a', '#8fe0ae', '#ffb8bf', '#9aa8c0', '#f0c47b',
  '#f6aeb5', '#a9d5ff'
])

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > .5 ? d / (2 - max - min) : d / (max + min)
  let h
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6
  else if (max === g) h = ((b - r) / d + 2) / 6
  else h = ((r - g) / d + 4) / 6
  return [h, s, l]
}

function hueToRgb(p, q, t) {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h, s, l) {
  if (s === 0) return [l * 255, l * 255, l * 255]
  const q = l < .5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hueToRgb(p, q, h + 1 / 3) * 255, hueToRgb(p, q, h) * 255, hueToRgb(p, q, h - 1 / 3) * 255]
}

const hex = (value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')

function invertColor(text) {
  const lower = text.toLowerCase()
  if (STATUS_COLORS.has(lower)) return text
  let r, g, b, alpha
  let match
  if ((match = /^#([0-9a-f]{6})$/i.exec(text))) {
    r = parseInt(match[1].slice(0, 2), 16); g = parseInt(match[1].slice(2, 4), 16); b = parseInt(match[1].slice(4, 6), 16)
  } else if ((match = /^#([0-9a-f]{3})$/i.exec(text))) {
    r = parseInt(match[1][0] + match[1][0], 16); g = parseInt(match[1][1] + match[1][1], 16); b = parseInt(match[1][2] + match[1][2], 16)
  } else if ((match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(text))) {
    r = Number(match[1]); g = Number(match[2]); b = Number(match[3]); alpha = match[4] === undefined ? undefined : Number(match[4])
  } else {
    return text
  }
  // 纯黑是阴影，不翻。
  if (r === 0 && g === 0 && b === 0) return text
  const [h, s, l] = rgbToHsl(r, g, b)
  const [nr, ng, nb] = hslToRgb(h, s, 1 - l)
  const body = `#${hex(nr)}${hex(ng)}${hex(nb)}`
  return alpha === undefined ? body : `rgba(${Math.round(nr)}, ${Math.round(ng)}, ${Math.round(nb)}, ${alpha})`
}

function invertLine(line) {
  return line.replace(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b|rgba?\([^)]*\)/g, invertColor)
}

function scopeSelector(selector) {
  return selector.split(',').map((part) => {
    const value = part.trim()
    if (!value) return value
    if (value.startsWith('body.panel-window')) return value.replace('body.panel-window', 'body.panel-window.panel-theme-light')
    if (value.startsWith('body.')) return `body.panel-theme-light${value.slice(4)}`
    return `body.panel-theme-light ${value}`
  }).join(', ')
}

const lines = fs.readFileSync(source, 'utf8').split(/\r?\n/)
const out = ['/* 由 scripts/build-panel-light.cjs 生成，不要手改。 */']
let keyframes = 0
let pending = []
for (const line of lines) {
  const trimmed = line.trim()
  if (!trimmed) { out.push(line); continue }
  if (trimmed.startsWith('@import')) continue
  if (trimmed.startsWith('/*') || trimmed.startsWith('*')) { out.push(line); continue }
  if (keyframes > 0) {
    out.push(line)
    keyframes += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    continue
  }
  if (trimmed.startsWith('@keyframes')) {
    out.push(line)
    keyframes = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length
    continue
  }
  if (trimmed.startsWith('@media') || trimmed.startsWith('@supports')) {
    out.push(line)
    continue
  }
  // 多行选择器：以逗号结尾、还没有 '{' 的行先攒着，等 '{' 那一行一起加前缀。
  if (!line.includes('{') && trimmed.endsWith(',')) {
    pending.push(line)
    continue
  }
  const brace = line.indexOf('{')
  if (brace >= 0 && !trimmed.startsWith('}')) {
    const headSource = pending.length ? [...pending, line].join('\n') : line
    pending = []
    const full = headSource
    const at = full.indexOf('{')
    out.push(`${scopeSelector(full.slice(0, at))}${invertLine(full.slice(at))}`)
    continue
  }
  if (pending.length) {
    out.push(...pending)
    pending = []
  }
  out.push(invertLine(line))
}
fs.writeFileSync(target, out.join('\n'), 'utf8')
console.log(`wrote ${target} (${out.length} lines)`)
