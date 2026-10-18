/** Small visual feedback on the artwork layer. The button and BrowserWindow
 * never transform: dragging and hit testing always use the same rectangle. */

export function clickBounceFrames(): Keyframe[] {
  return [
    { offset: 0, transform: 'translateY(0px) scaleY(1)' },
    { offset: .34, transform: 'translateY(-2.2px) scaleY(1.008)' },
    { offset: .72, transform: 'translateY(.8px) scaleY(.995)' },
    { offset: 1, transform: 'translateY(0px) scaleY(1)' }
  ];
}

export function clickBounceTiming(): KeyframeAnimationOptions {
  return { duration: 280, easing: 'cubic-bezier(.22, 1, .36, 1)' };
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

/** The OS setting can change while the app is open. */
export function watchReducedMotion(onChange: (reduced: boolean) => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const query = window.matchMedia('(prefers-reduced-motion: reduce)');
  const change = (): void => onChange(query.matches);
  query.addEventListener?.('change', change);
  return () => query.removeEventListener?.('change', change);
}

const lastPlayed = new WeakMap<Element, Animation>();

export function cancelClickBounce(el: Element | null): void {
  if (!el) return;
  const previous = lastPlayed.get(el);
  lastPlayed.delete(el);
  previous?.cancel();
}

export function playClickBounce(el: Element | null, reduced = prefersReducedMotion()): Animation | null {
  if (!el) return null;
  cancelClickBounce(el);
  if (reduced) return null;
  const target = el as Element & { animate?: HTMLElement['animate'] };
  if (typeof target.animate !== 'function') return null;
  const animation = target.animate(clickBounceFrames(), clickBounceTiming());
  lastPlayed.set(el, animation);
  animation.onfinish = () => { if (lastPlayed.get(el) === animation) lastPlayed.delete(el); };
  return animation;
}
