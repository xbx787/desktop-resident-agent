import { createRequire } from 'node:module'
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { crc32, pngAlphaMetricsFromBuffer, assetInventory, validateMetrics, anchorGeometryFailures, audit } = require('../scripts/audit-active-avatar-assets.cjs')

function chunk(type: string, body: Buffer): Buffer {
  const name = Buffer.from(type, 'ascii')
  const size = Buffer.alloc(4)
  size.writeUInt32BE(body.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([name, body])))
  return Buffer.concat([size, name, body, crc])
}

function encodeRows(filter: number): Buffer {
  const rows = [
    Buffer.from([1, 2, 3, 0, 4, 5, 6, 255]),
    Buffer.from([7, 8, 9, 8, 10, 11, 12, 128])
  ]
  const scanlines: Buffer[] = []
  for (let y = 0; y < rows.length; y++) {
    const current = rows[y]
    const previous = y ? rows[y - 1] : Buffer.alloc(current.length)
    const encoded = Buffer.alloc(current.length)
    for (let i = 0; i < current.length; i++) {
      const left = i >= 4 ? current[i - 4] : 0
      const up = previous[i]
      const upperLeft = i >= 4 ? previous[i - 4] : 0
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
      encoded[i] = (current[i] - predictor + 256) & 255
    }
    scanlines.push(Buffer.from([filter]), encoded)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(2, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(scanlines))),
    chunk('IEND', Buffer.alloc(0))
  ])
}

describe('actual avatar asset gate', () => {
  it.each([0, 1, 2, 3, 4])('decodes alpha after PNG row filter %s', (filter) => {
    const metrics = pngAlphaMetricsFromBuffer(encodeRows(filter))
    expect(metrics).toMatchObject({ width: 2, height: 2, pixels: 2, solidPixels: 2, bottomMargin: 0,
      box: { x: 1, y: 0, width: 1, height: 2 } })
  })

  it('rejects corrupted PNG bytes instead of treating them as invisible artwork', () => {
    const corrupt = Buffer.from(encodeRows(0))
    corrupt[50] ^= 0x10
    expect(() => pngAlphaMetricsFromBuffer(corrupt)).toThrow(/校验值错误/)
  })

  it('rejects a one-pixel ahoge and an opaque rectangle', () => {
    const onePixel = { width: 1024, height: 1024, pixels: 1, solidPixels: 1,
      box: { x: 400, y: 20, width: 1, height: 1 }, alphaRatio: 1 / 1024 ** 2 }
    expect(validateMetrics({ role: 'ahoge', name: 'ahoge.png' }, onePixel).join(' ')).toMatch(/几乎没有可见 alpha/)
    const opaque = { width: 500, height: 800, pixels: 399_000, solidPixels: 399_000,
      box: { x: 0, y: 0, width: 500, height: 800 }, alphaRatio: .9975 }
    expect(validateMetrics({ role: 'persona-body', name: 'rin.png' }, opaque).join(' ')).toMatch(/不透明背景/)
  })

  it('detects stale square-canvas assumptions after a transparent portrait is cropped', () => {
    const source = 'export const AHOGE_ROOT = { x: 636 / 1254, y: 118 / 1254 }; const size = Math.min(rect.width, rect.height)'
    const body = { width: 1016, height: 1218 }
    const layer = { box: { x: 300, y: 20, width: 200, height: 80 } }
    const findings = anchorGeometryFailures(source, body, layer)
    expect(findings.some((item: string) => item.includes('旧画布'))).toBe(true)
    expect(findings.some((item: string) => item.includes('正方形'))).toBe(true)
  })

  it('checks named canvas dimensions without rejecting correct rectangular contain geometry', () => {
    const body = { width: 1016, height: 1218 }
    const layer = { box: { x: 400, y: 20, width: 220, height: 90 } }
    const correct = 'AHOGE_CANVAS = { width: 1016, height: 1218 }; AHOGE_ROOT = { x: 502 / AHOGE_CANVAS.width, y: 88 / AHOGE_CANVAS.height }; Math.min(rect.width / AHOGE_CANVAS.width, rect.height / AHOGE_CANVAS.height)'
    expect(anchorGeometryFailures(correct, body, layer)).toEqual([])
    expect(anchorGeometryFailures(correct.replace('height: 1218', 'height: 1254'), body, layer).join(' ')).toMatch(/AHOGE_CANVAS/)
  })

  it('discovers all render-linked bodies, avatars and poses without staging files', () => {
    const assets = assetInventory()
    expect(assets.filter((a: { role: string }) => a.role === 'persona-body')).toHaveLength(4)
    expect(assets.filter((a: { role: string }) => a.role === 'pose')).toHaveLength(7)
    expect(assets.filter((a: { role: string }) => a.role === 'reference')).toHaveLength(1)
    expect(audit().results).toHaveLength(assets.length)
  })
})
