import { describe, expect, it } from 'vitest'
import { resolveLocalLive2DResource } from '../src/renderer/live2d-manifest'

describe('Live2DPortrait resource boundary', () => {
  const fileBase = 'file:///D:/DesktopPetProject/out/renderer/avatar.html'
  const webBase = 'http://localhost:5173/avatar.html'

  it('accepts bundled Cubism resources below the local live2d tree', () => {
    expect(resolveLocalLive2DResource('./live2d/arch-chan/arch%20chan%20model0.model3.json', fileBase, 'model'))
      .toBe('file:///D:/DesktopPetProject/out/renderer/live2d/arch-chan/arch%20chan%20model0.model3.json')
    expect(resolveLocalLive2DResource('/live2d/core/live2dcubismcore.min.js', webBase, 'core'))
      .toBe('http://localhost:5173/live2d/core/live2dcubismcore.min.js')
  })

  it('rejects CDNs, traversal and mismatched resource types', () => {
    expect(resolveLocalLive2DResource('https://cdn.example.test/model.model3.json', webBase, 'model')).toBeNull()
    expect(resolveLocalLive2DResource('../live2d/model.model3.json', fileBase, 'model')).toBeNull()
    expect(resolveLocalLive2DResource('./live2d/model.model3.json', fileBase, 'core')).toBeNull()
    expect(resolveLocalLive2DResource('./live2d/core/live2dcubismcore.min.js', fileBase, 'model')).toBeNull()
  })
})
