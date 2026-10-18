import { describe, expect, it } from 'vitest'
import { cancelPoseSwap, nextPose, playPoseSwap, POSES, poseGapMs, poseHoldMs, poseSrc } from '../src/renderer/avatar-poses'

describe('pose library', () => {
  it('rotates only upright expressions and never randomly jumps into a whole-body pose', () => {
    const ids = POSES.map((pose) => pose.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['surprise', 'sleepy', 'shy'])
    expect(POSES.every((pose) => pose.kind === 'expression')).toBe(true)
    expect(ids).not.toContain('doze')
    expect(poseSrc('doze')).toBeNull()
    for (const pose of POSES) expect(poseSrc(pose.id)).toBeTruthy()
    expect(poseSrc('nope')).toBeNull()
  })

  it('reserves focus and smile for the state faces, out of the random rotation', () => {
    expect(POSES.some((pose) => pose.id === 'focus' || pose.id === 'smile')).toBe(false)
    expect(poseSrc('focus')).toBeTruthy()
    expect(poseSrc('smile')).toBeTruthy()
  })
})

describe('pose clock pacing', () => {
  it('keeps occasional idle expressions brief and well spaced', () => {
    expect(poseGapMs(() => 0)).toBe(30000)
    expect(poseGapMs(() => 1)).toBe(60000)
    expect(poseHoldMs(() => 0)).toBe(2200)
    expect(poseHoldMs(() => 1)).toBe(4000)
  })

  it('never picks the pose that was just showing', () => {
    for (const pose of POSES) {
      for (const roll of [0, 0.5, 0.999]) {
        expect(nextPose(pose.id, () => roll).id).not.toBe(pose.id)
      }
    }
    expect(nextPose(null, () => 0)).toBe(POSES[0])
  })
})

describe('playPoseSwap', () => {
  it('applies immediately without an element or under reduced motion', () => {
    let applied = 0
    playPoseSwap(null, () => { applied += 1 })
    const fake = { animate: () => { throw new Error('must not animate') } } as unknown as Element
    playPoseSwap(fake, () => { applied += 1 }, true)
    expect(applied).toBe(2)
  })

  it('changes the artwork only after an opacity dip, without moving the silhouette', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel(): void }> = []
    const fake = {
      animate: (frames: Keyframe[]) => {
        expect(frames.every((frame) => 'opacity' in frame && !('transform' in frame))).toBe(true)
        const animation = { onfinish: null as (() => void) | null, cancel() {} }
        animations.push(animation)
        return animation as unknown as Animation
      }
    } as unknown as Element
    let appliedAt = -1
    playPoseSwap(fake, () => { appliedAt = animations.length }, false)
    expect(animations.length).toBe(1)
    expect(appliedAt).toBe(-1) // still mid-squash
    animations[0].onfinish?.()
    expect(appliedAt).toBe(1) // applied while only the squash exists — the rebound starts after
    expect(animations.length).toBe(2)
    animations[1].onfinish?.()
  })

  it('cannot apply a stale expression after a rapid state switch or cancellation', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel(): void; cancelled: boolean }> = []
    const fake = { animate: () => {
      const animation = { onfinish: null as (() => void) | null, cancelled: false,
        cancel() { this.cancelled = true } }
      animations.push(animation)
      return animation as unknown as Animation
    } } as unknown as Element
    const applied: string[] = []
    playPoseSwap(fake, () => applied.push('idle'), false)
    const staleFinish = animations[0].onfinish
    playPoseSwap(fake, () => applied.push('working'), false)
    expect(animations[0].cancelled).toBe(true)
    staleFinish?.()
    expect(applied).toEqual([])
    animations[1].onfinish?.()
    expect(applied).toEqual(['working'])
    cancelPoseSwap(fake)
    animations[2].onfinish?.()
    expect(applied).toEqual(['working'])
  })
})
