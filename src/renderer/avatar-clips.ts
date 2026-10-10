/** The smear-clip player's data and frame stepping. A clip is a short run of
 *  pre-drawn frames (base → motion-blur → far pose → blur back, per the
 *  edit-chain prompts in reference/character-motion-plan.md): discrete keys
 *  with a smear in between — how hand-drawn animation has always faked a fast
 *  move. Frames are plain artwork files, so the same normalize pipeline that
 *  produced the poses produces these. */

export interface ClipSpec {
  /** Frame sources in playback order. */
  frames: readonly string[]
  /** Playback rate; ~10 fps reads right for a 4-frame flick. */
  fps: number
  /** 'loop' keeps cycling (a back-and-forth flick), 'once' ends the clip. */
  loop: 'once' | 'loop'
}

/** Clip library — assets/clips/<id>/ (scripts/clip-normalize.cjs output).
 *  A miss keeps the poke at the plain click bounce, so the library can grow
 *  one batch at a time. */
export const CLIPS: Record<string, ClipSpec> = {
  // The poke reaction: ahoge left → blurred mid-swing → planted right →
  // blurred back, then the base artwork returns and the clip ends. Four
  // frames is exactly one there-and-back flick.
  'ear-flick': {
    frames: [
      new URL('./assets/clips/ear-flick/01.png', import.meta.url).href,
      new URL('./assets/clips/ear-flick/02.png', import.meta.url).href,
      new URL('./assets/clips/ear-flick/03.png', import.meta.url).href,
      new URL('./assets/clips/ear-flick/04.png', import.meta.url).href
    ],
    fps: 10,
    loop: 'once'
  }
}

/** The clip a poke plays once the library has one. */
export const CLICK_CLIP = 'ear-flick'

/** The frame after `index`; null when a once-clip has just shown its last
 *  frame. */
export function nextFrame(index: number, count: number, loop: ClipSpec['loop']): number | null {
  if (count <= 0) return null
  if (loop === 'loop') return (index + 1) % count
  return index + 1 < count ? index + 1 : null
}
