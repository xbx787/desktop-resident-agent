// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({
  apps: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>
}))

vi.mock('pixi.js', () => {
  class Application {
    renderer = { resize: vi.fn() }
    stage: { addChild: ReturnType<typeof vi.fn>; removeChild: ReturnType<typeof vi.fn> }
    destroy: ReturnType<typeof vi.fn>

    constructor() {
      const children = new Set<Record<string, unknown>>()
      this.stage = {
        addChild: vi.fn((model: Record<string, unknown>) => {
          children.add(model)
          model.parent = this.stage
        }),
        removeChild: vi.fn((model: Record<string, unknown>) => {
          children.delete(model)
          if (model.parent === this.stage) model.parent = null
        })
      }
      this.destroy = vi.fn((_removeView: boolean, options?: { children?: boolean }) => {
        if (!options?.children) return
        for (const child of children) (child.destroy as ReturnType<typeof vi.fn>)()
      })
      runtime.apps.push(this as unknown as Record<string, unknown>)
    }
  }
  return { Application }
})

vi.mock('pixi-live2d-display/cubism4', () => ({
  MotionPriority: { NONE: 0, IDLE: 1, NORMAL: 2, FORCE: 3 },
  MotionPreloadStrategy: { ALL: 'ALL', IDLE: 'IDLE', NONE: 'NONE' },
  Live2DModel: {
    from: vi.fn(async () => {
      const loadedMotion = { setIsLoop: vi.fn(), setIsLoopFadeIn: vi.fn() }
      const motionManager = {
        definitions: {
          Idle: [{}], Acknowledge: [{}], Thinking: [{}],
          Working: [{}], Success: [{}], Failure: [{}]
        },
        stopAllMotions: vi.fn(),
        loadMotion: vi.fn(async () => loadedMotion)
      }
      const model = {
        destroyed: false,
        parent: null as unknown,
        autoInteract: true,
        interactive: true,
        buttonMode: true,
        autoUpdate: true,
        internalModel: { motionManager },
        scale: { set: vi.fn() },
        anchor: { set: vi.fn() },
        position: { set: vi.fn() },
        getLocalBounds: () => ({ width: 100, height: 100 }),
        motion: vi.fn(async () => true),
        destroy: vi.fn()
      }
      runtime.models.push(model as unknown as Record<string, unknown>)
      return model
    })
  }
}))

import { Live2DPortrait } from '../src/renderer/Live2DPortrait'
import { live2dManifestFor } from '../src/renderer/live2d-manifest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore
  runtime.apps.length = 0
  runtime.models.length = 0
})

describe('Live2DPortrait lifecycle', () => {
  it('removes a failed Core script so the preview can retry, then destroys the model only once', async () => {
    const manifest = live2dManifestFor('arch-chan')
    expect(manifest).not.toBeNull()
    const lanes = { task: 'idle' as const, voice: 'silent' as const, interaction: 'none' as const }
    const failed = vi.fn()
    const firstMount = document.createElement('div')
    document.body.append(firstMount)
    const firstRoot = createRoot(firstMount)

    await act(async () => {
      firstRoot.render(<Live2DPortrait manifest={manifest} lanes={lanes} onError={failed} />)
      await Promise.resolve()
    })
    const firstScript = document.querySelector('script[data-live2d-core="true"]') as HTMLScriptElement
    expect(firstScript).toBeTruthy()
    await act(async () => {
      firstScript.dispatchEvent(new Event('error'))
      await Promise.resolve()
    })
    expect(failed).toHaveBeenCalledTimes(1)
    expect(document.querySelector('script[data-live2d-core="true"]')).toBeNull()
    await act(async () => firstRoot.unmount())

    const secondMount = document.createElement('div')
    document.body.append(secondMount)
    const secondRoot = createRoot(secondMount)
    const ready = vi.fn()
    await act(async () => {
      secondRoot.render(<Live2DPortrait manifest={manifest} lanes={lanes} onReady={ready} />)
      await Promise.resolve()
    })
    const retryScript = document.querySelector('script[data-live2d-core="true"]') as HTMLScriptElement
    expect(retryScript).toBeTruthy()
    expect(retryScript).not.toBe(firstScript)
    ;(window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
    await act(async () => {
      retryScript.dispatchEvent(new Event('load'))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(ready).toHaveBeenCalledWith(manifest)
    expect(runtime.models).toHaveLength(1)

    await act(async () => {
      secondRoot.render(<Live2DPortrait manifest={manifest} lanes={lanes} reducedMotion onReady={ready} />)
      await Promise.resolve()
    })
    expect(runtime.models[0].autoUpdate).toBe(false)

    await act(async () => secondRoot.unmount())
    const model = runtime.models[0]
    const app = runtime.apps.at(-1)!
    expect(model.destroy as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1)
    expect((app.stage as { removeChild: ReturnType<typeof vi.fn> }).removeChild)
      .toHaveBeenCalledWith(model)
  })

  it('loops persistent states, uses priorities and does not restart an unchanged lane', async () => {
    const manifest = live2dManifestFor('arch-chan')!
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const idle = { task: 'idle' as const, voice: 'silent' as const, interaction: 'none' as const }

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={idle} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const model = runtime.models.at(-1)! as {
      motion: ReturnType<typeof vi.fn>
      internalModel: { motionManager: {
        loadMotion: ReturnType<typeof vi.fn>
        stopAllMotions: ReturnType<typeof vi.fn>
      } }
    }
    expect(model.motion).toHaveBeenCalledWith('Idle', 0, 1)
    const idleLoad = await model.internalModel.motionManager.loadMotion.mock.results[0].value
    expect(idleLoad.setIsLoop).toHaveBeenCalledWith(true)
    expect(idleLoad.setIsLoopFadeIn).toHaveBeenCalledWith(false)

    const idleCalls = model.motion.mock.calls.length
    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={{ ...idle }} />)
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenCalledTimes(idleCalls)

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest}
        lanes={{ task: 'planning', voice: 'silent', interaction: 'none' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Thinking', 0, 2)

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest}
        lanes={{ task: 'completed', voice: 'silent', interaction: 'none' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Success', 0, 3)
    expect(model.internalModel.motionManager.stopAllMotions.mock.calls.length).toBeGreaterThanOrEqual(3)
    await act(async () => root.unmount())
  })
})
