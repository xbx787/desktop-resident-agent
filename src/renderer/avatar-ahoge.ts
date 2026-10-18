/** The ahoge flick. The base portrait and ahoge layer share a 1016×1218
 *  cropped canvas, so at
 *  rest the two stack back into the original artwork pixel-perfectly. A poke
 *  swings only the layer around its root — one hand-drawn part moves while
 *  everything else stays exactly still, which is what the four-frame smear
 *  batch failed to do. Frames use rotation only (the layer's own artwork
 *  carries the shape); reduced motion skips the swing. */

import { prefersReducedMotion } from './avatar-motion'

/** Original root (636,118) minus the active asset's crop origin (134,30).
 * The current layer image needs repairing before this motion becomes visible. */
export const AHOGE_CANVAS = { width: 1016, height: 1218 }
export const AHOGE_ROOT = { x: 502 / AHOGE_CANVAS.width, y: 88 / AHOGE_CANVAS.height }

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

/** Map the cropped, non-square canvas through object-fit: contain. */
export function ahogeOrigin(rect: { width: number; height: number }): { x: number; y: number } {
  const scale = Math.min(rect.width / AHOGE_CANVAS.width, rect.height / AHOGE_CANVAS.height)
  const width = AHOGE_CANVAS.width * scale
  const height = AHOGE_CANVAS.height * scale
  return {
    x: (rect.width - width) / 2 + AHOGE_ROOT.x * width,
    y: (rect.height - height) / 2 + AHOGE_ROOT.y * height
  }
}

const lastPlayed = new WeakMap<Element, Animation>()

export function cancelAhogeFlick(el: Element | null): void {
  if (!el) return
  const previous = lastPlayed.get(el)
  lastPlayed.delete(el)
  previous?.cancel()
}

export function playAhogeFlick(el: Element | null, reduced = prefersReducedMotion()): void {
  const target = el as (Element & { animate?: HTMLElement['animate'] }) | null
  if (!target) return
  cancelAhogeFlick(target)
  if (reduced || typeof target.animate !== 'function') return
  const origin = ahogeOrigin({ width: (target as HTMLElement).clientWidth, height: (target as HTMLElement).clientHeight })
  ;(target as HTMLElement).style.transformOrigin = `${origin.x}px ${origin.y}px`
  const animation = target.animate(ahogeFlickFrames(), ahogeFlickTiming())
  lastPlayed.set(target, animation)
  animation.onfinish = () => { if (lastPlayed.get(target) === animation) lastPlayed.delete(target) }
}
