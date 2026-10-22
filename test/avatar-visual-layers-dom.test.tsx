// @vitest-environment jsdom
import { act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AvatarVisualLayers } from '../src/renderer/AvatarVisualLayers'
import { resolveLive2DLayerState } from '../src/renderer/live2d-layer-state'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('AvatarVisualLayers Live2D handoff', () => {
  it('mounts while loading, preserves that host when ready, and restores fallback after failure', async () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function Probe() {
      useEffect(() => {
        mounted()
        return unmounted
      }, [])
      return <canvas data-testid="live2d-canvas" />
    }
    const key = 'arch-chan:arch-chan-state-preview'
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const render = async (ready: boolean, failed: boolean) => {
      const state = resolveLive2DLayerState(key, { key: ready || failed ? key : null, ready, failed })
      await act(async () => root.render(<AvatarVisualLayers
        state={state}
        live2d={<Probe />}
        fallback={<img data-testid="fallback" />}
        effects={<span data-testid="effects" />}
      />))
    }

    await render(false, false)
    const canvas = container.querySelector('[data-testid="live2d-canvas"]')
    expect(canvas).toBeTruthy()
    expect(container.querySelector('[data-live2d-layer="loading"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="fallback"]')).toBeTruthy()
    expect(mounted).toHaveBeenCalledTimes(1)

    await render(true, false)
    expect(container.querySelector('[data-testid="live2d-canvas"]')).toBe(canvas)
    expect(container.querySelector('[data-live2d-layer="ready"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="fallback"]')).toBeNull()
    expect(container.querySelector('[data-testid="effects"]')).toBeNull()
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()

    await render(false, true)
    expect(container.querySelector('[data-testid="live2d-canvas"]')).toBeNull()
    expect(container.querySelector('[data-testid="fallback"]')).toBeTruthy()
    expect(unmounted).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
  })
})
