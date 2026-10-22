export interface Live2DLoadState {
  readonly key: string | null
  readonly ready: boolean
  readonly failed: boolean
}

export interface Live2DLayerState {
  /** Mount the Cubism host so it can finish loading and report readiness. */
  readonly mount: boolean
  /** Reveal the Cubism canvas only after this exact model is ready. */
  readonly visible: boolean
  /** Keep the PNG portrait visible while Cubism is unavailable or loading. */
  readonly showFallback: boolean
  readonly phase: 'disabled' | 'loading' | 'ready' | 'failed'
}

/**
 * Loading and visibility are deliberately separate. If the host were mounted
 * only after `ready`, its own `onReady` callback could never run.
 */
export function resolveLive2DLayerState(
  manifestKey: string | null,
  load: Live2DLoadState
): Live2DLayerState {
  if (!manifestKey) {
    return { mount: false, visible: false, showFallback: true, phase: 'disabled' }
  }

  const appliesToManifest = load.key === manifestKey
  if (appliesToManifest && load.failed) {
    return { mount: false, visible: false, showFallback: true, phase: 'failed' }
  }
  if (appliesToManifest && load.ready) {
    return { mount: true, visible: true, showFallback: false, phase: 'ready' }
  }
  return { mount: true, visible: false, showFallback: true, phase: 'loading' }
}
