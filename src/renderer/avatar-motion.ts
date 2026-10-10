/** The click feedback: a short squash-and-rebound played with the Web
 *  Animation API. The avatar window clips to a 160×180 shape while the art
 *  draws a 160×160 square inside it — about 10 px of vertical slack, none
 *  horizontal — so frames may only move on translateY and scaleY, and the
 *  numbers stay inside that budget (test/avatar-motion.test.ts fails if a
 *  frame would paint outside the shape). */

/** One press-and-rebound pass, in order. */
export function clickBounceFrames(): Keyframe[] {
  return [
    { offset: 0, transform: 'translateY(4.5px) scaleY(0.96)' },
    { offset: 0.38, transform: 'translateY(-3.5px) scaleY(1.02)' },
    { offset: 0.68, transform: 'translateY(1.5px) scaleY(0.996)' },
    { offset: 1, transform: 'translateY(0px) scaleY(1)' }
  ]
}

export function clickBounceTiming(): KeyframeAnimationOptions {
  return { duration: 320, easing: 'cubic-bezier(.22, 1.4, .36, 1)' }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches)
}

const lastPlayed = new WeakMap<Element, Animation>()

/** Plays the click bounce on `el` and returns the animation, or null when
 *  there is no element, the element cannot animate, or the system asked for
 *  reduced motion. A quick second click cancels the previous pass so repeated
 *  pokes restart cleanly instead of stacking. */
export function playClickBounce(el: Element | null, reduced = prefersReducedMotion()): Animation | null {
  if (!el || reduced) return null
  const target = el as Element & { animate?: HTMLElement['animate'] }
  if (typeof target.animate !== 'function') return null
  lastPlayed.get(el)?.cancel()
  const animation = target.animate(clickBounceFrames(), clickBounceTiming())
  lastPlayed.set(el, animation)
  return animation
}
