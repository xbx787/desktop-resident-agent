import { describe, expect, it } from 'vitest'
import { AVATAR_CONTENT_SIZE, avatarDisplaySize } from '../src/renderer/avatar-geometry'

describe('trimmed avatar display size', () => {
  it('fits the long edge to the original visible content without ever upscaling', () => {
    for (const [width, height] of [[1209, 1233], [1016, 1218], [832, 996], [775, 996], [996, 697], [716, 996]]) {
      const size = avatarDisplaySize(width, height)
      expect(Math.max(size.width, size.height)).toBeCloseTo(AVATAR_CONTENT_SIZE)
      expect(size.width).toBeLessThanOrEqual(AVATAR_CONTENT_SIZE + 1e-9)
      expect(size.height).toBeLessThanOrEqual(AVATAR_CONTENT_SIZE + 1e-9)
    }
  })

  it('keeps the trimmed aspect ratio so a lying pose stays wide', () => {
    const doze = avatarDisplaySize(996, 697)
    expect(doze.width).toBeGreaterThan(doze.height * 1.4)
    const body = avatarDisplaySize(1016, 1218)
    expect(body.height).toBeGreaterThan(body.width)
  })

  it('falls back to zero before the image has loaded', () => {
    expect(avatarDisplaySize(0, 0)).toEqual({ width: 0, height: 0 })
  })
})
