import type { ReactNode } from 'react'
import type { Live2DLayerState } from './live2d-layer-state'

interface AvatarVisualLayersProps {
  readonly state: Live2DLayerState
  readonly live2d: ReactNode
  readonly fallback: ReactNode
  readonly effects: ReactNode
}

/**
 * Keeps the Cubism subtree mounted during loading. This small component has no
 * Electron bootstrap side effects, so the loading-to-ready handoff can be
 * exercised directly in a DOM test.
 */
export function AvatarVisualLayers({ state, live2d, fallback, effects }: AvatarVisualLayersProps) {
  return <>
    {state.mount && <div
      className={`avatar-gesture avatar-live2d-layer is-${state.phase}`}
      data-live2d-layer={state.phase}
      aria-hidden={true}>
      {live2d}
    </div>}
    {state.showFallback && fallback}
    {state.showFallback && effects}
  </>
}
