import { prefersReducedMotion } from './avatar-motion';

export interface PoseSpec {
  id: string;
  kind: 'pose' | 'expression';
}

/** Idle uses only portraits in the same upright framing as the base image.
 * The older wave/cheer/doze sprites switch silhouette and crop abruptly. */
export const POSES: readonly PoseSpec[] = [
  { id: 'surprise', kind: 'expression' },
  { id: 'sleepy', kind: 'expression' },
  { id: 'shy', kind: 'expression' }
];

const SOURCES: Record<string, string> = {
  smile: new URL('./assets/poses/smile.png', import.meta.url).href,
  surprise: new URL('./assets/poses/surprise.png', import.meta.url).href,
  focus: new URL('./assets/poses/focus.png', import.meta.url).href,
  sleepy: new URL('./assets/poses/sleepy.png', import.meta.url).href,
  shy: new URL('./assets/poses/shy.png', import.meta.url).href,
  failed: new URL('./assets/poses/failed.png', import.meta.url).href,
  question: new URL('./assets/poses/question.png', import.meta.url).href
};

export function poseSrc(id: string): string | null {
  return SOURCES[id] ?? null;
}

export function poseGapMs(random: () => number = Math.random): number {
  return 30000 + random() * 30000;
}

export function poseHoldMs(random: () => number = Math.random): number {
  return 2200 + random() * 1800;
}

export function nextPose(currentId: string | null, random: () => number = Math.random): PoseSpec {
  const pool = POSES.filter((pose) => pose.id !== currentId);
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))];
}

type Swap = { down: Animation | null; up: Animation | null };
const swaps = new WeakMap<Element, Swap>();

export function cancelPoseSwap(el: Element | null): void {
  if (!el) return;
  const previous = swaps.get(el);
  swaps.delete(el);
  previous?.down?.cancel();
  previous?.up?.cancel();
}

/** Dip the portrait opacity, change the sprite, then restore it. The image
 * never changes the hit target's size or the character's screen position.
 * A new request invalidates prior completion callbacks before cancelling WAAPI. */
export function playPoseSwap(el: Element | null, apply: () => void, reduced = prefersReducedMotion()): void {
  if (el) cancelPoseSwap(el);
  const target = el as (Element & { animate?: HTMLElement['animate'] }) | null;
  if (!el || !target || reduced || typeof target.animate !== 'function') {
    apply();
    return;
  }
  const swap: Swap = { down: null, up: null };
  swaps.set(el, swap);
  const down = target.animate(
    [{ opacity: 1 }, { opacity: .42 }],
    { duration: 100, easing: 'ease-in', fill: 'forwards' }
  );
  swap.down = down;
  down.onfinish = () => {
    if (swaps.get(el) !== swap) return;
    apply();
    down.cancel();
    const up = target.animate(
      [{ opacity: .42 }, { opacity: 1 }],
      { duration: 160, easing: 'ease-out' }
    );
    swap.up = up;
    up.onfinish = () => { if (swaps.get(el) === swap) swaps.delete(el); };
  };
}

let warmed = false;

/** Warm the expression cache before the first state transition. */
export function preloadPoses(): void {
  if (warmed || typeof Image === 'undefined') return;
  warmed = true;
  for (const id of [...POSES.map((pose) => pose.id), 'focus', 'smile', 'failed', 'question']) {
    const image = new Image();
    image.src = SOURCES[id];
  }
}

/** Timer is mounted only while the renderer is genuinely idle. */
export function startPoseClock(swap: (pose: PoseSpec | null) => void, random: () => number = Math.random): () => void {
  let timer: number | undefined;
  let stopped = false;
  let showing = false;
  let last: string | null = null;
  const schedule = (delay: number): void => { timer = window.setTimeout(tick, delay); };
  const tick = (): void => {
    if (stopped) return;
    if (document.hidden || document.body.classList.contains('is-resting') || prefersReducedMotion()) {
      schedule(5000);
      return;
    }
    if (showing) {
      showing = false;
      swap(null);
      schedule(poseGapMs(random));
    } else {
      const next = nextPose(last, random);
      last = next.id;
      showing = true;
      swap(next);
      schedule(poseHoldMs(random));
    }
  };
  schedule(poseGapMs(random));
  return () => {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
