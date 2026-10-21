/**
 * One idle-behaviour clock for the desktop character.
 *
 * The scheduler knows nothing about React, the DOM or animation APIs. The
 * caller supplies the actions (blink, fidget and expression today), and an
 * action may return a cleanup function that stops its current animation. This
 * keeps behaviours mutually exclusive and lets a task, voice turn or drag
 * cancel both the active action and the next timer with one `stop()` call.
 */

export type AvatarBehaviorId = 'blink' | 'fidget' | 'expression'
export type MillisecondRange = readonly [number, number]

export interface AvatarBehaviorDefinition {
  id: AvatarBehaviorId
  /** Relative chance among behaviours that are currently off cooldown. */
  weight: number
  /** Time after this action finishes before the same action may run again. */
  cooldownMs: number
  /** Time for which this action owns the single behaviour slot. */
  durationMs: MillisecondRange
}

export interface AvatarBehaviorProfile {
  initialDelayMs: MillisecondRange
  gapMs: MillisecondRange
  behaviors: readonly AvatarBehaviorDefinition[]
}

export type AvatarBehaviorCleanup = () => void
export type AvatarBehaviorAction = () => void | AvatarBehaviorCleanup
export type AvatarBehaviorActions = Partial<Record<AvatarBehaviorId, AvatarBehaviorAction>>

type TimerHandle = ReturnType<typeof globalThis.setTimeout>
type SetTimer = (callback: () => void, delayMs: number) => TimerHandle
type ClearTimer = (handle: TimerHandle) => void

export interface AvatarBehaviorSchedulerOptions {
  personaId?: string | null
  /** Tests and future user-authored personas may supply a complete profile. */
  profile?: AvatarBehaviorProfile
  actions: AvatarBehaviorActions
  reducedMotion?: boolean
  random?: () => number
  now?: () => number
  setTimeout?: SetTimer
  clearTimeout?: ClearTimer
  onError?: (error: unknown, behavior: AvatarBehaviorId) => void
}

const DURATIONS = {
  blink: [120, 190] as const,
  fidget: [560, 760] as const,
  expression: [2200, 4000] as const
}

/**
 * Personality changes frequency, not semantics: every renderer still owns the
 * same three action callbacks. A lively persona fidgets more often, while a
 * reserved one mostly blinks and leaves longer expression cooldowns.
 */
export const AVATAR_BEHAVIOR_PROFILES: Readonly<Record<string, AvatarBehaviorProfile>> = {
  xiaojing: {
    initialDelayMs: [1800, 4200],
    gapMs: [2400, 5200],
    behaviors: [
      { id: 'blink', weight: 6, cooldownMs: 2400, durationMs: DURATIONS.blink },
      { id: 'fidget', weight: 2, cooldownMs: 18000, durationMs: DURATIONS.fidget },
      { id: 'expression', weight: 1.4, cooldownMs: 28000, durationMs: DURATIONS.expression }
    ]
  },
  rin: {
    initialDelayMs: [2200, 4600],
    gapMs: [2700, 5400],
    behaviors: [
      { id: 'blink', weight: 7, cooldownMs: 2800, durationMs: DURATIONS.blink },
      { id: 'fidget', weight: 1.4, cooldownMs: 22000, durationMs: DURATIONS.fidget },
      { id: 'expression', weight: 0.7, cooldownMs: 36000, durationMs: DURATIONS.expression }
    ]
  },
  rem: {
    initialDelayMs: [2200, 4800],
    gapMs: [2800, 5600],
    behaviors: [
      { id: 'blink', weight: 6.5, cooldownMs: 2700, durationMs: DURATIONS.blink },
      { id: 'fidget', weight: 1, cooldownMs: 26000, durationMs: DURATIONS.fidget },
      { id: 'expression', weight: 1, cooldownMs: 32000, durationMs: DURATIONS.expression }
    ]
  },
  yui: {
    initialDelayMs: [1200, 3000],
    gapMs: [1800, 4000],
    behaviors: [
      { id: 'blink', weight: 5.5, cooldownMs: 2100, durationMs: DURATIONS.blink },
      { id: 'fidget', weight: 2.8, cooldownMs: 15000, durationMs: DURATIONS.fidget },
      { id: 'expression', weight: 1.8, cooldownMs: 24000, durationMs: DURATIONS.expression }
    ]
  },
  yukino: {
    initialDelayMs: [2800, 5600],
    gapMs: [3200, 6200],
    behaviors: [
      { id: 'blink', weight: 7.5, cooldownMs: 3200, durationMs: DURATIONS.blink },
      { id: 'fidget', weight: 0.8, cooldownMs: 30000, durationMs: DURATIONS.fidget },
      { id: 'expression', weight: 0.5, cooldownMs: 45000, durationMs: DURATIONS.expression }
    ]
  }
}

export function avatarBehaviorProfileFor(personaId: string | null | undefined): AvatarBehaviorProfile {
  return AVATAR_BEHAVIOR_PROFILES[personaId ?? ''] ?? AVATAR_BEHAVIOR_PROFILES.xiaojing
}

function randomUnit(random: () => number): number {
  const value = random()
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1 - Number.EPSILON, Math.max(0, value))
}

function sampleRange(range: MillisecondRange, random: () => number): number {
  const low = Math.max(0, Math.min(range[0], range[1]))
  const high = Math.max(low, Math.max(range[0], range[1]))
  if (low === high) return Math.round(low)
  return Math.round(low + (high - low) * randomUnit(random))
}

function weightedChoice(behaviors: readonly AvatarBehaviorDefinition[], random: () => number): AvatarBehaviorDefinition {
  const total = behaviors.reduce((sum, behavior) => sum + behavior.weight, 0)
  let target = randomUnit(random) * total
  for (const behavior of behaviors) {
    target -= behavior.weight
    if (target < 0) return behavior
  }
  return behaviors[behaviors.length - 1]
}

const noop = (): void => {}

export function startAvatarBehaviorScheduler(options: AvatarBehaviorSchedulerOptions): () => void {
  if (options.reducedMotion) return noop

  const profile = options.profile ?? avatarBehaviorProfileFor(options.personaId)
  const definitions = profile.behaviors.filter((behavior, index, all) =>
    behavior.weight > 0 && Number.isFinite(behavior.weight) &&
    typeof options.actions[behavior.id] === 'function' &&
    all.findIndex((candidate) => candidate.id === behavior.id) === index)
  if (!definitions.length) return noop

  const random = options.random ?? Math.random
  const now = options.now ?? Date.now
  const setTimer: SetTimer = options.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const clearTimer: ClearTimer = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle))
  const cooldownUntil = new Map<AvatarBehaviorId, number>()

  let stopped = false
  let timer: TimerHandle | null = null
  let active: AvatarBehaviorId | null = null
  let activeCleanup: AvatarBehaviorCleanup | null = null

  const report = (error: unknown, behavior: AvatarBehaviorId): void => {
    try { options.onError?.(error, behavior) } catch { /* an observer must not break the clock */ }
  }

  const cleanupActive = (): void => {
    const behavior = active
    const cleanup = activeCleanup
    active = null
    activeCleanup = null
    if (!cleanup) return
    try { cleanup() } catch (error) { if (behavior) report(error, behavior) }
  }

  const schedule = (delayMs: number, callback: () => void): void => {
    if (stopped) return
    timer = setTimer(() => {
      timer = null
      callback()
    }, Math.max(0, Math.round(delayMs)))
  }

  const scheduleNext = (): void => schedule(sampleRange(profile.gapMs, random), runNext)

  function finishActive(): void {
    if (stopped) return
    cleanupActive()
    scheduleNext()
  }

  function runNext(): void {
    if (stopped || active) return
    const time = now()
    const eligible = definitions.filter((behavior) => (cooldownUntil.get(behavior.id) ?? -Infinity) <= time)
    if (!eligible.length) {
      const earliest = Math.min(...definitions.map((behavior) => cooldownUntil.get(behavior.id) ?? time))
      schedule(Math.max(1, earliest - time), runNext)
      return
    }

    const behavior = weightedChoice(eligible, random)
    const duration = sampleRange(behavior.durationMs, random)
    active = behavior.id
    try {
      const cleanup = options.actions[behavior.id]?.()
      activeCleanup = typeof cleanup === 'function' ? cleanup : null
    } catch (error) {
      report(error, behavior.id)
      active = null
      activeCleanup = null
      scheduleNext()
      return
    }
    if (stopped) {
      cleanupActive()
      return
    }
    cooldownUntil.set(behavior.id, time + duration + Math.max(0, behavior.cooldownMs))
    schedule(duration, finishActive)
  }

  schedule(sampleRange(profile.initialDelayMs, random), runNext)

  return () => {
    if (stopped) return
    stopped = true
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    cleanupActive()
  }
}
