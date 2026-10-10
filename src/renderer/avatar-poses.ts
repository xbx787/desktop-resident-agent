/** The portrait's pose library and its idle swap clock: every so often the
 *  character swaps into one of the generation-batch poses for a few seconds,
 *  then returns to the base artwork — the "did she just do something?"
 *  layer, on top of the breath. The swap itself (squash down, change the
 *  artwork at the bottom of the dip, spring back) rides WAAPI on the portrait
 *  layer, inside the same window-shape budget as everything else here. */

import { prefersReducedMotion } from './avatar-motion'

export interface PoseSpec {
  id: string
  /** pose = whole-body art; expression = a face variant on the base pose. */
  kind: 'pose' | 'expression'
}

export const POSES: readonly PoseSpec[] = [
  { id: 'wave', kind: 'pose' },
  { id: 'doze', kind: 'pose' },
  { id: 'cheer', kind: 'pose' },
  { id: 'dozy', kind: 'pose' },
  { id: 'smile', kind: 'expression' },
  { id: 'surprise', kind: 'expression' },
  { id: 'focus', kind: 'expression' },
  { id: 'sleepy', kind: 'expression' },
  { id: 'shy', kind: 'expression' }
]

/** Explicit per-pose URLs (scripts/pose-normalize.cjs output) — the same
 *  pattern as avatar-art.ts, so the bundler sees every sprite statically. */
const SOURCES: Record<string, string> = {
  wave: new URL('./assets/poses/wave.png', import.meta.url).href,
  doze: new URL('./assets/poses/doze.png', import.meta.url).href,
  cheer: new URL('./assets/poses/cheer.png', import.meta.url).href,
  dozy: new URL('./assets/poses/dozy.png', import.meta.url).href,
  smile: new URL('./assets/poses/smile.png', import.meta.url).href,
  surprise: new URL('./assets/poses/surprise.png', import.meta.url).href,
  focus: new URL('./assets/poses/focus.png', import.meta.url).href,
  sleepy: new URL('./assets/poses/sleepy.png', import.meta.url).href,
  shy: new URL('./assets/poses/shy.png', import.meta.url).href
}

export function poseSrc(id: string): string | null {
  return SOURCES[id] ?? null
}

/** Idle wait between swaps: long enough that each pose reads as a mood, not
 *  a metronome. */
export function poseGapMs(random: () => number = Math.random): number {
  return 22000 + random() * 38000
}

/** How long a swapped-in pose stays before the portrait returns to base. */
export function poseHoldMs(random: () => number = Math.random): number {
  return 3200 + random() * 4800
}

/** The next pose: never the one that was just showing. */
export function nextPose(currentId: string | null, random: () => number = Math.random): PoseSpec {
  const pool = POSES.filter((pose) => pose.id !== currentId)
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]
}

/** The swap's two-stage move: squash into the change, change the artwork at
 *  the bottom of the dip, spring back out. Frames use translateY/scaleY only
 *  (the window clips), and reduced motion just changes the artwork. */
export function playPoseSwap(el: Element | null, apply: () => void, reduced = prefersReducedMotion()): void {
  const target = el as (Element & { animate?: HTMLElement['animate'] }) | null
  if (!target || reduced || typeof target.animate !== 'function') {
    apply()
    return
  }
  const down = target.animate(
    [{ transform: 'translateY(0) scaleY(1)' }, { transform: 'translateY(3px) scaleY(0.965)' }],
    { duration: 150, easing: 'ease-in', fill: 'forwards' }
  )
  down.onfinish = () => {
    apply()
    const up = target.animate(
      [
        { transform: 'translateY(3px) scaleY(0.965)' },
        { transform: 'translateY(-1.5px) scaleY(1.006)' },
        { transform: 'translateY(0) scaleY(1)' }
      ],
      { duration: 300, easing: 'ease-out' }
    )
    up.onfinish = () => { down.cancel() }
  }
}

/** Warms the decode cache so a swap never flashes an empty frame. */
export function preloadPoses(): void {
  if (typeof Image === 'undefined') return
  for (const pose of POSES) {
    const src = poseSrc(pose.id)
    if (src) {
      const image = new Image()
      image.src = src
    }
  }
}

/** The idle swap clock: wait → show a pose → hold → return to base → wait …
 *  While the window is hidden the clock idles on a slow poll instead of
 *  swapping behind nobody's back. */
export function startPoseClock(swap: (pose: PoseSpec | null) => void, random: () => number = Math.random): () => void {
  let timer: number | undefined
  let stopped = false
  let showing = false
  let last: string | null = null
  const schedule = (delay: number): void => { timer = window.setTimeout(tick, delay) }
  const tick = (): void => {
    if (stopped) return
    if (document.hidden) { schedule(5000); return }
    if (showing) {
      showing = false
      swap(null)
      schedule(poseGapMs(random))
    } else {
      const next = nextPose(last, random)
      last = next.id
      showing = true
      swap(next)
      schedule(poseHoldMs(random))
    }
  }
  schedule(poseGapMs(random))
  return () => {
    stopped = true
    if (timer !== undefined) window.clearTimeout(timer)
  }
}
