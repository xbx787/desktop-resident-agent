import { describe, expect, it } from 'vitest'
import { faceForAvatarEmotion, resolveAvatarLanes } from '../src/renderer/avatar-lanes'

describe('avatar orthogonal lanes', () => {
  it('keeps the underlying task while voice and interaction take their own lanes', () => {
    expect(resolveAvatarLanes({
      snapshot: { taskStatus: 'executing', avatarState: 'speaking' },
      dragging: true,
      panelOpen: true
    })).toEqual({ task: 'executing', work: 'none', voice: 'speaking', interaction: 'dragging', emotion: 'happy' })
  })

  it('distinguishes planning, executing, verifying and compacting', () => {
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'planning', avatarState: 'thinking' } }).task).toBe('planning')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'executing', avatarState: 'acting' } }).task).toBe('executing')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'verifying', avatarState: 'acting' } }).task).toBe('verifying')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'executing', avatarState: 'acting', contextCompacting: true } }).task).toBe('compacting')
  })

  it('keeps the current tool semantic separate from the task phase', () => {
    expect(resolveAvatarLanes({
      snapshot: { taskStatus: 'executing', avatarState: 'acting', agentActivity: 'searching' }
    }).work).toBe('searching')
  })

  it('shows a sent-message acknowledgement before the planning pose', () => {
    expect(resolveAvatarLanes({
      snapshot: { taskStatus: 'planning', avatarState: 'thinking' },
      acknowledging: true
    }).task).toBe('received')
    expect(resolveAvatarLanes({
      snapshot: { taskStatus: 'executing', avatarState: 'acting' },
      acknowledging: true
    }).task).toBe('executing')
  })

  it('treats every parked user decision as waiting even before status catches up', () => {
    const question = { id: 'q', questions: [] }
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'executing', avatarState: 'thinking', question } }).task).toBe('waiting')
  })

  it('returns an old completed or failed snapshot to idle after its local outcome cue', () => {
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'done', avatarState: 'success' } }).task).toBe('idle')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'failed', avatarState: 'error' } }).task).toBe('idle')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'done', avatarState: 'idle' }, settled: 'done' }).task).toBe('completed')
    expect(resolveAvatarLanes({ snapshot: { taskStatus: 'failed', avatarState: 'idle' }, settled: 'failed' }).task).toBe('failed')
  })

  it('maps emotion to a face without changing persona identity', () => {
    expect(faceForAvatarEmotion('happy')).toBe('smile')
    expect(faceForAvatarEmotion('focused')).toBe('focus')
    expect(faceForAvatarEmotion('surprised')).toBe('surprise')
    expect(faceForAvatarEmotion('worried')).toBe('failed')
    expect(faceForAvatarEmotion('neutral')).toBeNull()
  })
})
