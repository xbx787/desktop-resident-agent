/** The idle fidget: every so often the portrait stretches and settles, so the
 *  character reads as alive between interactions. The slow breath lives in
 *  avatar.css (whale-breath); this file owns the random clock and the fidget
 *  itself. Frames use translateY/scaleY only, inside the same window-shape
 *  budget as the click bounce (test/avatar-idle.test.ts checks it). */

import { prefersReducedMotion } from './avatar-motion'

/** One stretch-and-settle pass, in order. */
export function idleFidgetFrames(): Keyframe[] {
  return [
    { offset: 0, transform: 'translateY(0px) scaleY(1)' },
    { offset: 0.25, transform: 'translateY(1.5px) scaleY(0.988)' },
    { offset: 0.55, transform: 'translateY(-3px) scaleY(1.01)' },
    { offset: 1, transform: 'translateY(0px) scaleY(1)' }
  ]
}

export function idleFidgetTiming(): KeyframeAnimationOptions {
  return { duration: 620, easing: 'cubic-bezier(.3, .9, .3, 1)' }
}

/** Delay before the next fidget: 18–45 s apart, so it reads as life rather
 *  than a loop. Injectable randomness for tests. */
export function nextFidgetDelay(random: () => number = Math.random): number {
  return 18000 + random() * 27000
}

/** Starts the fidget clock on `el` and returns a stop function. While the
 *  window is hidden a fidget would be wasted — the clock skips that turn and
 *  schedules the next one instead. Reduced motion (or a missing element)
 *  stops everything up front. */
export function startIdleFidgets(el: Element | null, reduced = prefersReducedMotion()): () => void {
  if (!el || reduced) return () => {}
  const target = el as Element & { animate?: HTMLElement['animate'] }
  if (typeof target.animate !== 'function') return () => {}
  let timer: number | undefined
  let last: Animation | null = null
  let stopped = false
  const schedule = (): void => {
    timer = window.setTimeout(() => {
      if (stopped) return
      if (!document.hidden) {
        last?.cancel()
        last = target.animate(idleFidgetFrames(), idleFidgetTiming())
      }
      schedule()
    }, nextFidgetDelay())
  }
  schedule()
  return () => {
    stopped = true
    if (timer !== undefined) window.clearTimeout(timer)
    last?.cancel()
  }
}
