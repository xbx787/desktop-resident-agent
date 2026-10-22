import { describe, expect, it } from 'vitest'
import type { AvatarLanes, AvatarTaskLane } from '../src/renderer/avatar-lanes'
import {
  AVATAR_EXECUTING_TO_PLANNING_GRACE_MS,
  AVATAR_TASK_MIN_VISIBLE_MS,
  reduceAvatarMotionPolicy,
  type AvatarMotionPolicyDecision
} from '../src/renderer/avatar-motion-policy'

function lanes(task: AvatarTaskLane, overrides: Partial<AvatarLanes> = {}): AvatarLanes {
  return {
    task,
    work: 'none',
    voice: 'silent',
    interaction: 'none',
    emotion: 'focused',
    ...overrides
  }
}

function next(
  previous: AvatarMotionPolicyDecision | null,
  task: AvatarTaskLane,
  now: number,
  overrides: Partial<AvatarLanes> = {},
  identity = 'chat-a:turn-1'
): AvatarMotionPolicyDecision {
  return reduceAvatarMotionPolicy(previous?.state ?? null, {
    identity,
    lanes: lanes(task, overrides),
    now
  })
}

describe('avatar motion policy', () => {
  it('keeps an ordinary active task visible for at least 450ms', () => {
    let result = next(null, 'planning', 10)
    result = next(result, 'executing', 100)

    expect(result.lanes.task).toBe('planning')
    expect(result.wakeAt).toBe(10 + AVATAR_TASK_MIN_VISIBLE_MS)
    expect(result.state.pending?.reason).toBe('minimum-visible')

    result = next(result, 'executing', 459)
    expect(result.lanes.task).toBe('planning')

    result = next(result, 'executing', 460)
    expect(result.lanes.task).toBe('executing')
    expect(result.wakeAt).toBeNull()
    expect(result.changed).toBe(true)
  })

  it('holds executing across a planning gap for 180ms after its request', () => {
    let result = next(null, 'executing', 0)
    result = next(result, 'planning', 500)

    expect(result.lanes.task).toBe('executing')
    expect(result.wakeAt).toBe(500 + AVATAR_EXECUTING_TO_PLANNING_GRACE_MS)
    expect(result.state.pending?.reason).toBe('executing-gap')

    result = next(result, 'planning', 679)
    expect(result.lanes.task).toBe('executing')
    result = next(result, 'planning', 680)
    expect(result.lanes.task).toBe('planning')
  })

  it('cancels a short planning gap when execution resumes', () => {
    let result = next(null, 'executing', 0)
    result = next(result, 'planning', 500)
    result = next(result, 'executing', 560)

    expect(result.lanes.task).toBe('executing')
    expect(result.state.pending).toBeNull()
    expect(result.wakeAt).toBeNull()

    result = next(result, 'executing', 700)
    expect(result.lanes.task).toBe('executing')
  })

  it.each(['waiting', 'completed', 'failed', 'cancelled'] as const)(
    'lets %s preempt the current task immediately',
    (task) => {
      let result = next(null, 'planning', 0)
      result = next(result, task, 20)

      expect(result.lanes.task).toBe(task)
      expect(result.state.pending).toBeNull()
      expect(result.state.taskSince).toBe(20)
    }
  )

  it('lets the acknowledgement preempt planning immediately, then keeps it readable', () => {
    let result = next(null, 'planning', 0)
    result = next(result, 'received', 20, { emotion: 'happy' })
    expect(result.lanes.task).toBe('received')
    expect(result.wakeAt).toBeNull()

    result = next(result, 'planning', 40)
    expect(result.lanes.task).toBe('received')
    expect(result.wakeAt).toBe(20 + AVATAR_TASK_MIN_VISIBLE_MS)
  })

  it('updates voice and dragging immediately while the task transition waits', () => {
    let result = next(null, 'planning', 0)
    result = next(result, 'executing', 100, {
      voice: 'speaking',
      interaction: 'dragging',
      work: 'writing',
      emotion: 'happy'
    })

    expect(result.lanes).toEqual({
      task: 'planning',
      voice: 'speaking',
      interaction: 'dragging',
      work: 'writing',
      emotion: 'happy'
    })
    expect(result.wakeAt).toBe(AVATAR_TASK_MIN_VISIBLE_MS)
    expect(result.changed).toBe(true)
  })

  it('clears a pending transition when the session or turn identity changes', () => {
    let result = next(null, 'planning', 0)
    result = next(result, 'executing', 100)
    expect(result.state.pending).not.toBeNull()

    result = next(result, 'executing', 120, {}, 'chat-b:turn-9')
    expect(result.identityChanged).toBe(true)
    expect(result.lanes.task).toBe('executing')
    expect(result.state.taskSince).toBe(120)
    expect(result.state.pending).toBeNull()
    expect(result.wakeAt).toBeNull()
  })

  it('does not delay a fresh task that starts from idle or an urgent pose', () => {
    let result = next(null, 'idle', 0, { emotion: 'neutral' })
    result = next(result, 'planning', 20)
    expect(result.lanes.task).toBe('planning')

    result = next(result, 'waiting', 30, { emotion: 'surprised' })
    result = next(result, 'executing', 40)
    expect(result.lanes.task).toBe('executing')
    expect(result.wakeAt).toBeNull()
  })
})
