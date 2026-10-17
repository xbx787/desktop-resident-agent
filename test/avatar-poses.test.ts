import { describe, expect, it } from 'vitest'
import { nextPose, playPoseSwap, POSES, poseGapMs, poseHoldMs, poseSrc } from '../src/renderer/avatar-poses'

describe('pose library', () => {
  it('ships one bust portrait, so every pose lookup falls back to the base artwork', () => {
    const ids = POSES.map((pose) => pose.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(POSES.length).toBe(7)
    for (const pose of POSES) expect(poseSrc(pose.id)).toBeNull()
    expect(poseSrc('focus')).toBeNull()
    expect(poseSrc('smile')).toBeNull()
    expect(poseSrc('nope')).toBeNull()
  })

  it('keeps focus and smile out of the random rotation', () => {
    expect(POSES.some((pose) => pose.id === 'focus' || pose.id === 'smile')).toBe(false)
  })
})

describe('pose clock pacing', () => {
  it('keeps swaps 22–60 s apart and holds each pose 3.2–8 s', () => {
    expect(poseGapMs(() => 0)).toBe(22000)
    expect(poseGapMs(() => 1)).toBe(60000)
    expect(poseHoldMs(() => 0)).toBe(3200)
    expect(poseHoldMs(() => 1)).toBe(8000)
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

  it('changes the artwork only after the squash finishes, then springs back', () => {
    const animations: Array<{ onfinish: (() => void) | null; cancel(): void }> = []
    const fake = {
      animate: () => {
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
})
