import type { AvatarLanes, AvatarTaskLane } from './avatar-lanes'

/** Active task poses should be readable before another ordinary pose replaces them. */
export const AVATAR_TASK_MIN_VISIBLE_MS = 450

/** Keep working through a brief tool-result gap instead of flashing back to thinking. */
export const AVATAR_EXECUTING_TO_PLANNING_GRACE_MS = 180

export type AvatarMotionPendingReason = 'minimum-visible' | 'executing-gap'

export interface AvatarMotionPendingTransition {
  task: AvatarTaskLane
  requestedAt: number
  applyAt: number
  reason: AvatarMotionPendingReason
}

export interface AvatarMotionPolicyState {
  /** Caller-owned session/turn key. A new key starts with a clean timeline. */
  identity: string | null
  visible: AvatarLanes
  taskSince: number
  pending: AvatarMotionPendingTransition | null
}

export interface AvatarMotionPolicyInput {
  /** Usually `${conversationId}:${turnId}`. Change it when either identity changes. */
  identity?: string | null
  lanes: AvatarLanes
  /** Monotonic timestamp in milliseconds, normally performance.now(). */
  now: number
}

export interface AvatarMotionPolicyDecision {
  state: AvatarMotionPolicyState
  lanes: AvatarLanes
  /** Schedule another reduction at this timestamp if no newer input arrives. */
  wakeAt: number | null
  changed: boolean
  identityChanged: boolean
}

const IMMEDIATE_TASKS = new Set<AvatarTaskLane>([
  'received',
  'waiting',
  'completed',
  'failed',
  'cancelled'
])

const MINIMUM_DWELL_TASKS = new Set<AvatarTaskLane>([
  'received',
  'planning',
  'executing',
  'verifying',
  'compacting'
])

function sameLanes(left: AvatarLanes, right: AvatarLanes): boolean {
  return left.task === right.task &&
    left.work === right.work &&
    left.voice === right.voice &&
    left.interaction === right.interaction &&
    left.emotion === right.emotion
}

function decision(
  previous: AvatarMotionPolicyState | null,
  state: AvatarMotionPolicyState,
  identityChanged: boolean
): AvatarMotionPolicyDecision {
  return {
    state,
    lanes: state.visible,
    wakeAt: state.pending?.applyAt ?? null,
    changed: previous === null || !sameLanes(previous.visible, state.visible),
    identityChanged
  }
}

function withTask(lanes: AvatarLanes, task: AvatarTaskLane): AvatarLanes {
  // Voice, pointer interaction, work semantic and emotion are independent
  // channels. They stay live even while the task pose is held for readability.
  return { ...lanes, task }
}

/**
 * Resolve a stable set of animation lanes from one renderer observation.
 *
 * The reducer owns no timer. When `wakeAt` is non-null, the caller should run
 * it again at that timestamp with the latest raw lanes. Any new observation
 * may be reduced immediately; returning to the visible task cancels a pending
 * transition. Waiting/outcome states bypass both dwell rules.
 */
export function reduceAvatarMotionPolicy(
  previous: AvatarMotionPolicyState | null,
  input: AvatarMotionPolicyInput
): AvatarMotionPolicyDecision {
  const identity = input.identity ?? null
  const identityChanged = previous !== null && previous.identity !== identity

  if (previous === null || identityChanged) {
    const state: AvatarMotionPolicyState = {
      identity,
      visible: { ...input.lanes },
      taskSince: input.now,
      pending: null
    }
    return decision(previous, state, identityChanged)
  }

  const requestedTask = input.lanes.task
  const visibleTask = previous.visible.task

  if (requestedTask === visibleTask) {
    const state: AvatarMotionPolicyState = {
      ...previous,
      visible: withTask(input.lanes, visibleTask),
      pending: null
    }
    return decision(previous, state, false)
  }

  // Parked questions and terminal outcomes must be visible immediately. An
  // urgent pose also yields immediately when work resumes; it has no dwell.
  if (IMMEDIATE_TASKS.has(requestedTask) || !MINIMUM_DWELL_TASKS.has(visibleTask)) {
    const state: AvatarMotionPolicyState = {
      identity,
      visible: { ...input.lanes },
      taskSince: input.now,
      pending: null
    }
    return decision(previous, state, false)
  }

  const samePendingTarget = previous.pending?.task === requestedTask
  const requestedAt = samePendingTarget ? previous.pending!.requestedAt : input.now
  const isExecutionGap = visibleTask === 'executing' && requestedTask === 'planning'
  const applyAt = Math.max(
    previous.taskSince + AVATAR_TASK_MIN_VISIBLE_MS,
    isExecutionGap ? requestedAt + AVATAR_EXECUTING_TO_PLANNING_GRACE_MS : Number.NEGATIVE_INFINITY
  )

  if (input.now >= applyAt) {
    const state: AvatarMotionPolicyState = {
      identity,
      visible: { ...input.lanes },
      taskSince: input.now,
      pending: null
    }
    return decision(previous, state, false)
  }

  const pending: AvatarMotionPendingTransition = {
    task: requestedTask,
    requestedAt,
    applyAt,
    reason: isExecutionGap ? 'executing-gap' : 'minimum-visible'
  }
  const state: AvatarMotionPolicyState = {
    ...previous,
    visible: withTask(input.lanes, visibleTask),
    pending
  }
  return decision(previous, state, false)
}
