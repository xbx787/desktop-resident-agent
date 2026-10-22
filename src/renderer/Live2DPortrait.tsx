import { useEffect, useRef } from 'react'
import * as PIXI from 'pixi.js'
import type { MotionPriority } from 'pixi-live2d-display'
import type { AvatarLanes } from './avatar-lanes'
import { resolveLocalLive2DResource, type Live2DAction, type Live2DMotionPriority, type Live2DModelManifest } from './live2d-manifest'

export interface Live2DViewport {
  anchor?: { x: number; y: number }
  offset?: { x: number; y: number }
  scale?: number
}

/** A DOM pointer position. It stays in viewport coordinates until the visual
 * host converts it to a Pixi canvas position; the hit target and the canvas
 * do not necessarily share the same top-left corner. */
export interface Live2DClientPoint {
  readonly clientX: number
  readonly clientY: number
}

export interface Live2DLocalPoint {
  readonly x: number
  readonly y: number
}

/**
 * Convert a pointer from viewport coordinates to the Live2D canvas's local
 * coordinate system. The result is clamped because an active pointer can be
 * captured by the avatar button while it leaves the visual canvas.
 */
export function localLive2DPoint(
  point: Live2DClientPoint,
  rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>,
  viewport: { width: number; height: number } = rect
): Live2DLocalPoint | null {
  if (![point.clientX, point.clientY, rect.left, rect.top, rect.width, rect.height, viewport.width, viewport.height].every(Number.isFinite)) return null
  if (rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return null
  return {
    x: Math.min(1, Math.max(0, (point.clientX - rect.left) / rect.width)) * viewport.width,
    y: Math.min(1, Math.max(0, (point.clientY - rect.top) / rect.height)) * viewport.height
  }
}

export interface Live2DPortraitProps {
  manifest: Live2DModelManifest | null
  /** The existing orthogonal state lanes stay the source of truth. */
  lanes: Pick<AvatarLanes, 'task' | 'voice' | 'interaction'>
  reducedMotion?: boolean
  /** Model-specific framing within the pre-existing fixed visual slot. */
  viewport?: Live2DViewport
  /**
   * Pointer information forwarded by the existing DOM avatar target. This
   * component never listens for pointer input itself.
   */
  pointerPosition?: Live2DClientPoint | null
  /** Increments only after a completed DOM click, never during a drag. */
  gestureEpoch?: number
  className?: string
  onReady?: (manifest: Live2DModelManifest) => void
  onError?: (error: Error) => void
}

type CubismRuntime = typeof import('pixi-live2d-display/cubism4')
type RuntimeModel = InstanceType<CubismRuntime['Live2DModel']>
interface MotionRequestState {
  key: string | null
  token: number
}

interface LoopableMotion {
  setIsLoop(loop: boolean): void
  setIsLoopFadeIn?(loopFadeIn: boolean): void
}

const coreLoads = new Map<string, Promise<void>>()
let cubismRuntime: Promise<CubismRuntime> | null = null

function loadCoreScript(src: string): Promise<void> {
  const previous = coreLoads.get(src)
  if (previous) return previous
  const promise = new Promise<void>((resolve, reject) => {
    const fail = (script: HTMLScriptElement): void => {
      script.dataset.live2dCoreState = 'error'
      script.remove()
      reject(new Error('Live2D Cubism Core 加载失败。'))
    }
    const existing = [...document.scripts].find((script) => script.src === src)
    if (existing) {
      if ((window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore) {
        resolve()
      } else if (existing.dataset.live2dCoreState === 'ready' || existing.dataset.live2dCoreState === 'error') {
        existing.remove()
        reject(new Error('Live2D Cubism Core 未初始化。'))
      } else {
        existing.addEventListener('load', () => {
          existing.dataset.live2dCoreState = 'ready'
          resolve()
        }, { once: true })
        existing.addEventListener('error', () => fail(existing), { once: true })
      }
      return
    }
    const script = document.createElement('script')
    script.src = src
    script.async = true
    script.dataset.live2dCore = 'true'
    script.dataset.live2dCoreState = 'loading'
    script.onload = () => {
      script.dataset.live2dCoreState = 'ready'
      resolve()
    }
    script.onerror = () => fail(script)
    document.head.append(script)
  })
  coreLoads.set(src, promise)
  // A failed local read or transient renderer error must not poison later
  // attempts after the user switches the preview off and back on.
  void promise.catch(() => {
    if (coreLoads.get(src) === promise) coreLoads.delete(src)
  })
  return promise
}

async function loadCubismRuntime(coreUrl: string): Promise<CubismRuntime> {
  const pixiWindow = window as Window & { PIXI?: typeof PIXI }
  // pixi-live2d-display uses this global to register its shared ticker.
  pixiWindow.PIXI = PIXI
  await loadCoreScript(coreUrl)
  if (!cubismRuntime) {
    let attempt: Promise<CubismRuntime>
    attempt = import('pixi-live2d-display/cubism4').catch((error: unknown) => {
      if (cubismRuntime === attempt) cubismRuntime = null
      throw error
    })
    cubismRuntime = attempt
  }
  return cubismRuntime
}

function modelMotionGroups(model: RuntimeModel): Readonly<Record<string, unknown>> {
  return model.internalModel?.motionManager?.definitions ?? {}
}

/**
 * Models are authored independently. These fallbacks keep an older model
 * useful while a richer Xiaojing package is being produced, without leaking
 * model group names into the application state machine.
 */
const ACTION_FALLBACKS: Readonly<Record<Live2DAction, readonly Live2DAction[]>> = Object.freeze({
  idle: ['idle'],
  acknowledge: ['acknowledge', 'idle'],
  thinking: ['thinking', 'idle'],
  working: ['working', 'thinking', 'idle'],
  verifying: ['verifying', 'working', 'thinking', 'idle'],
  waiting: ['waiting', 'thinking', 'idle'],
  success: ['success', 'acknowledge', 'idle'],
  failure: ['failure', 'idle'],
  listening: ['listening', 'thinking', 'idle'],
  speaking: ['speaking', 'working', 'thinking', 'idle'],
  poke: ['poke', 'acknowledge', 'idle']
})

export function live2dActionCandidates(action: Live2DAction): readonly Live2DAction[] {
  return ACTION_FALLBACKS[action]
}

function motionForAction(
  model: RuntimeModel,
  manifest: Live2DModelManifest,
  action: Live2DAction
): { action: Live2DAction; motion: NonNullable<Live2DModelManifest['motions'][Live2DAction]> } | null {
  const groups = modelMotionGroups(model)
  for (const candidate of live2dActionCandidates(action)) {
    const motion = manifest.motions[candidate]
    if (motion && Object.hasOwn(groups, motion.group)) return { action: candidate, motion }
  }
  return null
}

/** Maps the app's task and voice lanes to intentionally generic Live2D
 * actions. A model without a matching action simply keeps its authored idle
 * behaviour; no CSS substitute is introduced here. */
export function live2dActionForLanes(lanes: Pick<AvatarLanes, 'task' | 'voice' | 'interaction'>): Live2DAction | null {
  if (lanes.interaction === 'dragging') return null
  if (lanes.voice === 'listening') return 'listening'
  if (lanes.voice === 'speaking') return 'speaking'
  switch (lanes.task) {
    case 'idle': return 'idle'
    case 'received': return 'acknowledge'
    case 'planning':
    case 'compacting': return 'thinking'
    case 'waiting': return 'waiting'
    case 'executing': return 'working'
    case 'verifying': return 'verifying'
    case 'completed': return 'success'
    case 'failed':
    case 'cancelled': return 'failure'
    default: return null
  }
}

function runtimePriority(runtime: CubismRuntime, priority: Live2DMotionPriority): MotionPriority {
  if (priority === 'idle') return runtime.MotionPriority.IDLE
  if (priority === 'force') return runtime.MotionPriority.FORCE
  return runtime.MotionPriority.NORMAL
}

async function requestStateMotion(
  model: RuntimeModel,
  runtime: CubismRuntime,
  manifest: Live2DModelManifest,
  lanes: Pick<AvatarLanes, 'task' | 'voice' | 'interaction'>,
  reducedMotion: boolean,
  requestState: { current: MotionRequestState }
): Promise<void> {
  const manager = model.internalModel?.motionManager
  if (!manager) return
  if (reducedMotion || lanes.interaction === 'dragging') {
    requestState.current.token += 1
    requestState.current.key = null
    manager.stopAllMotions()
    return
  }
  const action = live2dActionForLanes(lanes)
  if (!action) return
  const resolved = motionForAction(model, manifest, action)
  if (!resolved) return
  const { motion } = resolved
  const request = `${action}:${resolved.action}:${motion.group}:${motion.index}:${motion.priority}:${motion.loop === true}`
  if (requestState.current.key === request) return

  const token = requestState.current.token + 1
  requestState.current = { key: request, token }
  // A NORMAL motion cannot replace another NORMAL motion in the current
  // runtime. The new lane is authoritative, so end the prior state first.
  manager.stopAllMotions()

  try {
    if (motion.loop) {
      const loaded = await manager.loadMotion(motion.group, motion.index) as LoopableMotion | undefined
      if (requestState.current.token !== token || requestState.current.key !== request) return
      if (!loaded || typeof loaded.setIsLoop !== 'function') throw new Error('Live2D loop motion is unavailable.')
      // Cubism parses Meta.Loop, but pixi-live2d-display 0.4.0 does not copy it
      // into CubismMotion's runtime loop flag.
      loaded.setIsLoop(true)
      loaded.setIsLoopFadeIn?.(false)
    }
    if (requestState.current.token !== token || requestState.current.key !== request) return
    await model.motion(motion.group, motion.index, runtimePriority(runtime, motion.priority))
  } catch {
    if (requestState.current.token === token && requestState.current.key === request) {
      requestState.current.key = null
    }
  }
}

async function requestGestureMotion(
  model: RuntimeModel,
  runtime: CubismRuntime,
  manifest: Live2DModelManifest,
  lanes: Pick<AvatarLanes, 'interaction'>,
  reducedMotion: boolean,
  requestState: { current: MotionRequestState }
): Promise<{ token: number; restoreAfterMs: number } | null> {
  const manager = model.internalModel?.motionManager
  if (!manager || reducedMotion || lanes.interaction === 'dragging') return null
  const resolved = motionForAction(model, manifest, 'poke')
  if (!resolved) return null
  const { motion } = resolved
  const token = requestState.current.token + 1
  requestState.current = {
    key: `gesture:${resolved.action}:${motion.group}:${motion.index}:${motion.priority}`,
    token
  }
  manager.stopAllMotions()
  try {
    const started = await model.motion(motion.group, motion.index, runtimePriority(runtime, motion.priority))
    if (!started || requestState.current.token !== token) return null
    // Older model packages may not yet author `Poke`.  Their semantic
    // fallback can be an acknowledge or idle group, but it must never leave
    // the current task loop permanently stopped after a click.  The richer
    // package supplies its own duration; legacy fallbacks get one short,
    // bounded hand-back to the currently active task state.
    const restoreAfterMs = motion.restoreStateAfterMs ?? 850
    return { token, restoreAfterMs }
  } catch {
    if (requestState.current.token === token) requestState.current.key = null
    return null
  }
}

function layoutModel(model: RuntimeModel, app: PIXI.Application, host: HTMLElement, viewport: Live2DViewport | undefined): void {
  const width = Math.max(1, Math.round(host.clientWidth))
  const height = Math.max(1, Math.round(host.clientHeight))
  app.renderer.resize(width, height)

  // Reset before measuring: `width`/`height` include the old scale.
  model.scale.set(1)
  const bounds = model.getLocalBounds()
  const sourceWidth = Math.max(1, bounds.width || model.width)
  const sourceHeight = Math.max(1, bounds.height || model.height)
  const scale = Math.min(width / sourceWidth, height / sourceHeight) * Math.max(.01, viewport?.scale ?? 1)
  const anchor = viewport?.anchor ?? { x: .5, y: 1 }
  const offset = viewport?.offset ?? { x: 0, y: 0 }
  model.anchor.set(anchor.x, anchor.y)
  model.scale.set(scale)
  model.position.set(width * anchor.x + offset.x, height * anchor.y + offset.y)
}

function applyPointerFocus(
  model: RuntimeModel,
  manifest: Live2DModelManifest,
  lanes: Pick<AvatarLanes, 'interaction'>,
  host: HTMLElement,
  pointerPosition: Live2DClientPoint | null | undefined,
  reducedMotion: boolean
): void {
  // This remains model capability-gated and DOM-owned. In particular, do not
  // turn on Pixi interaction as a shortcut: it would compete with the native
  // drag/click owner and reintroduce the overlay pointer regressions.
  if (!manifest.capabilities.pointerFocus) return
  try {
    if (reducedMotion || lanes.interaction === 'dragging' || !pointerPosition) {
      // focus(canvasCenter) is not neutral: this runtime normalizes every
      // pointer into a direction, including a zero-length vector.
      model.internalModel.focusController.focus(0, 0, reducedMotion || lanes.interaction === 'dragging')
      return
    }
    const point = localLive2DPoint(pointerPosition, host.getBoundingClientRect(), {
      width: host.clientWidth,
      height: host.clientHeight
    })
    if (!point) return
    model.focus(point.x, point.y)
  } catch {
    // A malformed third-party model must be able to fall back to the sprite
    // renderer instead of breaking the DOM drag target.
  }
}

function disposeModel(model: RuntimeModel | null): void {
  if (!model || model.destroyed) return
  model.destroy({ children: true, texture: true, baseTexture: true })
}

/**
 * Transparent visual-only Cubism host. It never registers Pixi interaction,
 * receives no pointer events, and has no layout-affecting transform. The
 * existing `.avatar-hit-target` remains the sole click/drag owner.
 */
export function Live2DPortrait({
  manifest,
  lanes,
  reducedMotion = false,
  viewport,
  pointerPosition,
  gestureEpoch = 0,
  className,
  onReady,
  onError
}: Live2DPortraitProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const modelRef = useRef<RuntimeModel | null>(null)
  const runtimeRef = useRef<CubismRuntime | null>(null)
  const appRef = useRef<PIXI.Application | null>(null)
  const stateRef = useRef({ lanes, reducedMotion, viewport, pointerPosition })
  const onReadyRef = useRef(onReady)
  const onErrorRef = useRef(onError)
  const motionRequestState = useRef<MotionRequestState>({ key: null, token: 0 })
  const gestureRestoreTimer = useRef<number | null>(null)
  const lastGestureEpoch = useRef(gestureEpoch)
  stateRef.current = { lanes, reducedMotion, viewport, pointerPosition }
  onReadyRef.current = onReady
  onErrorRef.current = onError

  useEffect(() => {
    const host = hostRef.current
    const canvas = canvasRef.current
    if (!host || !canvas || !manifest) return
    motionRequestState.current = { key: null, token: motionRequestState.current.token + 1 }
    const modelUrl = resolveLocalLive2DResource(manifest.modelResource, window.location.href, 'model')
    const coreUrl = resolveLocalLive2DResource(manifest.coreResource, window.location.href, 'core')
    if (!modelUrl || !coreUrl) {
      onErrorRef.current?.(new Error('Live2D 资源路径无效。'))
      return
    }

    let disposed = false
    let observer: ResizeObserver | null = null
    const app = new PIXI.Application({
      view: canvas,
      backgroundAlpha: 0,
      autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight)
    })
    appRef.current = app
    const resize = (): void => {
      const model = modelRef.current
      if (model && !disposed) {
        layoutModel(model, app, host, stateRef.current.viewport)
        applyPointerFocus(model, manifest, stateRef.current.lanes, host,
          stateRef.current.pointerPosition, stateRef.current.reducedMotion)
      }
      else app.renderer.resize(Math.max(1, host.clientWidth), Math.max(1, host.clientHeight))
    }
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(resize)
      observer.observe(host)
    }

    void (async () => {
      try {
        const runtime = await loadCubismRuntime(coreUrl)
        const model = await runtime.Live2DModel.from(modelUrl, {
          autoInteract: false,
          autoUpdate: true,
          motionPreload: runtime.MotionPreloadStrategy.ALL
        })
        if (disposed) {
          disposeModel(model)
          return
        }
        // The canvas is pointer-events:none as a second guard; these flags
        // keep Pixi itself from installing model hit areas or cursor handling.
        model.autoInteract = false
        model.interactive = false
        model.buttonMode = false
        model.autoUpdate = !stateRef.current.reducedMotion
        app.stage.addChild(model)
        modelRef.current = model
        runtimeRef.current = runtime
        layoutModel(model, app, host, stateRef.current.viewport)
        applyPointerFocus(model, manifest, stateRef.current.lanes, host,
          stateRef.current.pointerPosition, stateRef.current.reducedMotion)
        void requestStateMotion(model, runtime, manifest, stateRef.current.lanes,
          stateRef.current.reducedMotion, motionRequestState)
        host.dataset.live2dReady = 'true'
        onReadyRef.current?.(manifest)
      } catch (cause) {
        if (!disposed) {
          host.dataset.live2dError = 'true'
          onErrorRef.current?.(cause instanceof Error ? cause : new Error(String(cause)))
        }
      }
    })()

    return () => {
      disposed = true
      if (gestureRestoreTimer.current !== null) {
        window.clearTimeout(gestureRestoreTimer.current)
        gestureRestoreTimer.current = null
      }
      observer?.disconnect()
      host.removeAttribute('data-live2d-ready')
      const model = modelRef.current
      modelRef.current = null
      runtimeRef.current = null
      motionRequestState.current = { key: null, token: motionRequestState.current.token + 1 }
      if (model?.parent === app.stage) app.stage.removeChild(model)
      disposeModel(model)
      if (appRef.current === app) appRef.current = null
      app.destroy(true, { children: true, texture: true, baseTexture: true })
    }
  }, [manifest])

  useEffect(() => {
    const model = modelRef.current
    const runtime = runtimeRef.current
    if (model && runtime && manifest) {
      if (gestureRestoreTimer.current !== null) {
        window.clearTimeout(gestureRestoreTimer.current)
        gestureRestoreTimer.current = null
      }
      model.autoUpdate = !reducedMotion
      void requestStateMotion(model, runtime, manifest, lanes, reducedMotion, motionRequestState)
    }
  }, [manifest, lanes.task, lanes.voice, lanes.interaction, reducedMotion])

  useEffect(() => {
    const previous = lastGestureEpoch.current
    lastGestureEpoch.current = gestureEpoch
    if (gestureEpoch === previous) return
    const model = modelRef.current
    const runtime = runtimeRef.current
    if (!model || !runtime || !manifest) return
    if (gestureRestoreTimer.current !== null) {
      window.clearTimeout(gestureRestoreTimer.current)
      gestureRestoreTimer.current = null
    }
    void requestGestureMotion(model, runtime, manifest, lanes, reducedMotion, motionRequestState).then((restore) => {
      if (!restore || modelRef.current !== model) return
      gestureRestoreTimer.current = window.setTimeout(() => {
        gestureRestoreTimer.current = null
        if (modelRef.current !== model || motionRequestState.current.token !== restore.token) return
        motionRequestState.current.key = null
        void requestStateMotion(model, runtime, manifest, stateRef.current.lanes,
          stateRef.current.reducedMotion, motionRequestState)
      }, restore.restoreAfterMs)
    })
  }, [manifest, gestureEpoch, lanes.interaction, reducedMotion])

  useEffect(() => {
    const model = modelRef.current
    const host = hostRef.current
    if (model && host && manifest) {
      applyPointerFocus(model, manifest, lanes, host, pointerPosition, reducedMotion)
    }
  }, [manifest, pointerPosition?.clientX, pointerPosition?.clientY, lanes.interaction, reducedMotion])

  useEffect(() => {
    const model = modelRef.current
    const app = appRef.current
    const host = hostRef.current
    if (model && app && host) layoutModel(model, app, host, viewport)
  }, [viewport])

  return (
    <div ref={hostRef} className={['live2d-portrait', className].filter(Boolean).join(' ')} aria-hidden="true"
      style={{ width: '100%', height: '100%', pointerEvents: 'none', overflow: 'hidden' }}>
      <canvas ref={canvasRef} tabIndex={-1} style={{ display: 'block', width: '100%', height: '100%', pointerEvents: 'none' }} />
    </div>
  )
}
