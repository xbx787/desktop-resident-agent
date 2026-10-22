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
          Working: [{}], Verifying: [{}], Waiting: [{}],
          Success: [{}], Failure: [{}], Listening: [{}],
          Speaking: [{}], Poke: [{}]
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
        internalModel: { motionManager, focusController: { focus: vi.fn() } },
        scale: { set: vi.fn() },
        anchor: { set: vi.fn() },
        position: { set: vi.fn() },
        getLocalBounds: () => ({ width: 100, height: 100 }),
        motion: vi.fn(async () => true),
        focus: vi.fn(),
        destroy: vi.fn()
      }
      runtime.models.push(model as unknown as Record<string, unknown>)
      return model
    })
  }
}))

import { Live2DPortrait, localLive2DPoint } from '../src/renderer/Live2DPortrait'
import { live2dManifestFor } from '../src/renderer/live2d-manifest'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  document.body.innerHTML = ''
  delete (window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore
  runtime.apps.length = 0
  runtime.models.length = 0
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Live2DPortrait lifecycle', () => {
  it('converts client coordinates to the logical canvas size without multiplying by device pixel ratio', () => {
    const rect = { left: 40, top: 60, width: 200, height: 300 }
    expect(localLive2DPoint({ clientX: 140, clientY: 285 }, rect, { width: 100, height: 150 }))
      .toEqual({ x: 50, y: 112.5 })
    expect(localLive2DPoint({ clientX: -10, clientY: 900 }, rect, { width: 100, height: 150 }))
      .toEqual({ x: 0, y: 150 })
    expect(localLive2DPoint({ clientX: NaN, clientY: 20 }, rect)).toBeNull()
    expect(localLive2DPoint({ clientX: 50, clientY: 70 }, { ...rect, width: 0 })).toBeNull()
  })

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

  it('reacts when only the work semantic changes and starts a distinct authored motion', async () => {
    const base = live2dManifestFor('arch-chan')!
    const manifest = {
      ...base,
      motions: {
        ...base.motions,
        reading: { group: 'Thinking', index: 0, priority: 'normal' as const, loop: true },
        writing: { group: 'Working', index: 0, priority: 'normal' as const, loop: true }
      }
    }
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const executing = { task: 'executing' as const, voice: 'silent' as const, interaction: 'none' as const }

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={{ ...executing, work: 'reading' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const model = runtime.models.at(-1)! as { motion: ReturnType<typeof vi.fn> }
    expect(model.motion).toHaveBeenLastCalledWith('Thinking', 0, 2)

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={{ ...executing, work: 'writing' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Working', 0, 2)
    await act(async () => root.unmount())
  })

  it('does not restart one authored motion shared by different work semantics', async () => {
    const manifest = live2dManifestFor('arch-chan')!
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const executing = { task: 'executing' as const, voice: 'silent' as const, interaction: 'none' as const }

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={{ ...executing, work: 'reading' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const model = runtime.models.at(-1)! as {
      motion: ReturnType<typeof vi.fn>
      internalModel: { motionManager: { stopAllMotions: ReturnType<typeof vi.fn> } }
    }
    expect(model.motion).toHaveBeenLastCalledWith('Working', 0, 2)
    const motionCalls = model.motion.mock.calls.length
    const stopCalls = model.internalModel.motionManager.stopAllMotions.mock.calls.length

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={{ ...executing, work: 'writing' }} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenCalledTimes(motionCalls)
    expect(model.internalModel.motionManager.stopAllMotions).toHaveBeenCalledTimes(stopCalls)
    await act(async () => root.unmount())
  })

  it('plays the one-shot Poke motion when the DOM gesture epoch changes', async () => {
    const manifest = live2dManifestFor('arch-chan')!
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const lanes = { task: 'idle' as const, voice: 'silent' as const, interaction: 'none' as const }

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={lanes} gestureEpoch={0} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const model = runtime.models.at(-1)! as { motion: ReturnType<typeof vi.fn> }
    expect(model.motion).toHaveBeenLastCalledWith('Idle', 0, 1)

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={lanes} gestureEpoch={1} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Poke', 0, 3)
    await act(async () => root.unmount())
  })

  it('hands a legacy poke fallback back to the active task loop', async () => {
    vi.useFakeTimers()
    const manifest = live2dManifestFor('arch-chan')!
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const lanes = { task: 'executing' as const, voice: 'silent' as const, interaction: 'none' as const }

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={lanes} gestureEpoch={0} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    const model = runtime.models.at(-1)! as {
      motion: ReturnType<typeof vi.fn>
      internalModel: { motionManager: { definitions: Record<string, unknown> } }
    }
    delete model.internalModel.motionManager.definitions.Poke
    expect(model.motion).toHaveBeenLastCalledWith('Working', 0, 2)

    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={lanes} gestureEpoch={1} />)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Acknowledge', 0, 2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(850)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(model.motion).toHaveBeenLastCalledWith('Working', 0, 2)
    await act(async () => root.unmount())
  })

  it('focuses from the visual canvas, suspends during drag and reduced motion, then resumes and recenters on leave', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(150)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 40, top: 60, width: 200, height: 300
    } as DOMRect)
    const manifest = live2dManifestFor('arch-chan')!
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    const lanes = { task: 'idle' as const, voice: 'silent' as const, interaction: 'none' as const }
    const point = { clientX: 140, clientY: 285 }
    await act(async () => {
      root.render(<Live2DPortrait manifest={manifest} lanes={lanes} pointerPosition={point} />)
    })
    const model = runtime.models.at(-1)! as {
      focus: ReturnType<typeof vi.fn>
      autoUpdate: boolean
      internalModel: { focusController: { focus: ReturnType<typeof vi.fn> } }
    }
    expect(model.focus).toHaveBeenLastCalledWith(50, 112.5)
    model.focus.mockClear()

    await act(async () => root.render(<Live2DPortrait manifest={manifest}
      lanes={{ ...lanes, interaction: 'dragging' }} pointerPosition={point} />))
    expect(model.focus).not.toHaveBeenCalled()
    expect(model.internalModel.focusController.focus).toHaveBeenLastCalledWith(0, 0, true)
    await act(async () => root.render(<Live2DPortrait manifest={manifest} lanes={lanes} pointerPosition={point} />))
    expect(model.focus).toHaveBeenLastCalledWith(50, 112.5)
    model.focus.mockClear()

    await act(async () => root.render(<Live2DPortrait manifest={manifest} lanes={lanes} pointerPosition={point} reducedMotion />))
    expect(model.focus).not.toHaveBeenCalled()
    expect(model.autoUpdate).toBe(false)
    await act(async () => root.render(<Live2DPortrait manifest={manifest} lanes={lanes} pointerPosition={point} />))
    expect(model.focus).toHaveBeenLastCalledWith(50, 112.5)
    expect(model.autoUpdate).toBe(true)

    await act(async () => root.render(<Live2DPortrait manifest={manifest} lanes={lanes} pointerPosition={null} />))
    expect(model.internalModel.focusController.focus).toHaveBeenLastCalledWith(0, 0, false)
    await act(async () => root.unmount())
  })

  it('keeps pointer focus disabled for a model that has not opted in', async () => {
    const base = live2dManifestFor('arch-chan')!
    const manifest = { ...base, capabilities: { ...base.capabilities, pointerFocus: false } }
    const mount = document.createElement('div')
    document.body.append(mount)
    const root = createRoot(mount)
    await act(async () => root.render(<Live2DPortrait manifest={manifest}
      lanes={{ task: 'idle', voice: 'silent', interaction: 'none' }}
      pointerPosition={{ clientX: 80, clientY: 100 }} />))
    const model = runtime.models.at(-1)! as {
      focus: ReturnType<typeof vi.fn>
      internalModel: { focusController: { focus: ReturnType<typeof vi.fn> } }
    }
    expect(model.focus).not.toHaveBeenCalled()
    expect(model.internalModel.focusController.focus).not.toHaveBeenCalled()
    await act(async () => root.unmount())
  })
})
