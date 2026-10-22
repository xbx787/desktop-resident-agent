import { describe, expect, it } from 'vitest'
import { resolveLive2DLayerState } from '../src/renderer/live2d-layer-state'

describe('Live2D avatar layer state', () => {
  const key = 'arch-chan:arch-chan-state-preview'

  it('mounts the hidden Live2D host while keeping the PNG visible during loading', () => {
    expect(resolveLive2DLayerState(key, { key: null, ready: false, failed: false })).toEqual({
      mount: true,
      visible: false,
      showFallback: true,
      phase: 'loading'
    })
  })

  it('reveals only the exact model that reported ready', () => {
    expect(resolveLive2DLayerState(key, { key, ready: true, failed: false })).toEqual({
      mount: true,
      visible: true,
      showFallback: false,
      phase: 'ready'
    })
    expect(resolveLive2DLayerState(key, { key: 'other:model', ready: true, failed: false }).phase)
      .toBe('loading')
  })

  it('unmounts a failed host and keeps the PNG fallback', () => {
    expect(resolveLive2DLayerState(key, { key, ready: false, failed: true })).toEqual({
      mount: false,
      visible: false,
      showFallback: true,
      phase: 'failed'
    })
  })

  it('does not mount Live2D when the selected persona has no model', () => {
    expect(resolveLive2DLayerState(null, { key, ready: true, failed: false })).toEqual({
      mount: false,
      visible: false,
      showFallback: true,
      phase: 'disabled'
    })
  })
})
