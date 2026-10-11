/** The ahoge flick. The base portrait is split into a static body and an
 *  ahoge layer (scripts/ahoge-cut.cjs), both on the same 1254² canvas, so at
 *  rest the two stack back into the original artwork pixel-perfectly. A poke
 *  swings only the layer around its root — one hand-drawn part moves while
 *  everything else stays exactly still, which is what the four-frame smear
 *  batch failed to do. Frames use rotation only (the layer's own artwork
 *  carries the shape); reduced motion skips the swing. */

import { prefersReducedMotion } from './avatar-motion'

/** Root of the ahoge on the 1254² canvas — stays in sync with scripts/ahoge-cut.cjs. */
export const AHOGE_ROOT = { x: 636 / 1254, y: 118 / 1254 }

/** Knock the ahoge down, let it spring past level, settle. */
export function ahogeFlickFrames(): Keyframe[] {
  return [
    { offset: 0, transform: 'rotate(0deg)', easing: 'cubic-bezier(.4, 0, .9, .35)' },
    { offset: 0.22, transform: 'rotate(-15deg)', easing: 'cubic-bezier(.2, .7, .3, 1)' },
    { offset: 0.55, transform: 'rotate(9deg)', easing: 'cubic-bezier(.5, 0, .7, 1)' },
    { offset: 0.78, transform: 'rotate(-3.5deg)', easing: 'cubic-bezier(.4, 0, .5, 1)' },
    { offset: 1, transform: 'rotate(0deg)' }
  ]
}

export function ahogeFlickTiming(): KeyframeAnimationOptions {
  return { duration: 700 }
}

/** The layer is object-fit: contain inside its box, so the square artwork
 *  sits centred with letterbox bars; the root's pixel origin must be mapped
 *  through that geometry or the swing axis drifts when the window is not
 *  square. */
export function ahogeOrigin(rect: { width: number; height: number }): { x: number; y: number } {
  const size = Math.min(rect.width, rect.height)
  return {
    x: (rect.width - size) / 2 + AHOGE_ROOT.x * size,
    y: (rect.height - size) / 2 + AHOGE_ROOT.y * size
  }
}

export function playAhogeFlick(el: Element | null, reduced = prefersReducedMotion()): void {
  const target = el as (Element & { animate?: HTMLElement['animate'] }) | null
  if (!target || reduced || typeof target.animate !== 'function') return
  const origin = ahogeOrigin(target.getBoundingClientRect())
  ;(target as HTMLElement).style.transformOrigin = `${origin.x}px ${origin.y}px`
  target.animate(ahogeFlickFrames(), ahogeFlickTiming())
}
