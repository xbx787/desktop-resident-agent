import { describe, expect, it } from 'vitest'
import { AVATAR_CONTENT_SIZES, avatarDisplaySize } from '../src/renderer/avatar-geometry'

describe('trimmed avatar display size', () => {
  it('fits the long edge to the chosen size without ever exceeding it', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      for (const [width, height] of [[1209, 1233], [1016, 1218], [832, 996], [775, 996], [996, 697], [716, 996]]) {
        const box = avatarDisplaySize(width, height, size)
        expect(Math.max(box.width, box.height)).toBeCloseTo(AVATAR_CONTENT_SIZES[size])
        expect(box.width).toBeLessThanOrEqual(AVATAR_CONTENT_SIZES[size] + 1e-9)
        expect(box.height).toBeLessThanOrEqual(AVATAR_CONTENT_SIZES[size] + 1e-9)
      }
    }
  })

  it('grows monotonically across the small/medium/large stops', () => {
    expect(AVATAR_CONTENT_SIZES.small).toBeLessThan(AVATAR_CONTENT_SIZES.medium)
    expect(AVATAR_CONTENT_SIZES.medium).toBeLessThan(AVATAR_CONTENT_SIZES.large)
    expect(avatarDisplaySize(1209, 1233, 'large').height).toBeGreaterThan(avatarDisplaySize(1209, 1233, 'small').height)
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
