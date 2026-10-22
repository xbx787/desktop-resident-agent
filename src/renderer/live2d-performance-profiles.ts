import type { Live2DModelDefinition, Live2DModelId } from './live2d-model-catalog'

export type Live2DAction =
  | 'idle'
  | 'acknowledge'
  | 'thinking'
  | 'working'
  | 'verifying'
  | 'waiting'
  | 'success'
  | 'failure'
  | 'listening'
  | 'speaking'
  | 'poke'

export type Live2DMotionPriority = 'idle' | 'normal' | 'force'

/**
 * App-level motion semantics are deliberately separate from an authored
 * model's group names. A profile may omit any action when a model does not
 * support it, but every action it does map must preserve this behavior.
 */
export interface Live2DActionContract {
  readonly behavior: 'persistent' | 'one-shot'
  readonly restoreStateAfterMs: 'required' | 'forbidden'
}

export const live2dActionContracts = {
  idle: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  acknowledge: { behavior: 'one-shot', restoreStateAfterMs: 'forbidden' },
  thinking: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  working: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  verifying: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  waiting: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  success: { behavior: 'one-shot', restoreStateAfterMs: 'forbidden' },
  failure: { behavior: 'one-shot', restoreStateAfterMs: 'forbidden' },
  listening: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  speaking: { behavior: 'persistent', restoreStateAfterMs: 'forbidden' },
  poke: { behavior: 'one-shot', restoreStateAfterMs: 'required' }
} as const satisfies Readonly<Record<Live2DAction, Live2DActionContract>>

export interface Live2DMotionReference {
  readonly group: string
  readonly index: number
  readonly priority: Live2DMotionPriority
  /** Persistent state motions opt in because pixi-live2d-display 0.4.0 does
   * not apply motion3 Meta.Loop to CubismMotion automatically. */
  readonly loop?: boolean
  /** A one-shot interaction can hand the current task loop back after this delay. */
  readonly restoreStateAfterMs?: number
}

export type Live2DPerformanceProfileId = 'arch-chan-state-preview'

export interface Live2DPerformanceProfile {
  readonly id: Live2DPerformanceProfileId
  readonly modelId: Live2DModelId
  /** Semantic app states remain independent from model-specific group names. */
  readonly motions: Readonly<Partial<Record<Live2DAction, Live2DMotionReference>>>
}

const profiles: Readonly<Record<Live2DPerformanceProfileId, Live2DPerformanceProfile>> = {
  'arch-chan-state-preview': {
    id: 'arch-chan-state-preview',
    modelId: 'arch-chan',
    motions: {
      idle: { group: 'Idle', index: 0, priority: 'idle', loop: true },
      acknowledge: { group: 'Acknowledge', index: 0, priority: 'normal' },
      thinking: { group: 'Thinking', index: 0, priority: 'normal', loop: true },
      working: { group: 'Working', index: 0, priority: 'normal', loop: true },
      verifying: { group: 'Verifying', index: 0, priority: 'normal', loop: true },
      waiting: { group: 'Waiting', index: 0, priority: 'normal', loop: true },
      success: { group: 'Success', index: 0, priority: 'force' },
      failure: { group: 'Failure', index: 0, priority: 'force' },
      listening: { group: 'Listening', index: 0, priority: 'normal', loop: true },
      speaking: { group: 'Speaking', index: 0, priority: 'normal', loop: true },
      poke: { group: 'Poke', index: 0, priority: 'force', restoreStateAfterMs: 900 }
    }
  }
}

export function live2dPerformanceProfileFor(
  id: string | null | undefined
): Live2DPerformanceProfile | null {
  if (!id || !Object.prototype.hasOwnProperty.call(profiles, id)) return null
  return profiles[id as Live2DPerformanceProfileId]
}

/** Validate every semantic cue against the selected model's authored inventory. */
export function validateLive2DPerformanceProfile(
  model: Live2DModelDefinition,
  profile: Live2DPerformanceProfile
): readonly string[] {
  const errors: string[] = []
  if (profile.modelId !== model.id) errors.push(`profile ${profile.id} targets ${profile.modelId}, not ${model.id}`)
  for (const [action, motion] of Object.entries(profile.motions)) {
    if (!motion) continue
    const count = model.capabilities.motions[motion.group]
    if (count === undefined) {
      errors.push(`${action} references unknown motion group ${motion.group}`)
      continue
    }
    if (!Number.isInteger(motion.index) || motion.index < 0 || motion.index >= count) {
      errors.push(`${action} references invalid motion index ${motion.group}[${motion.index}]`)
      continue
    }

    const contract = live2dActionContracts[action as Live2DAction]
    if (!contract) {
      errors.push(`${action} is not a known semantic action`)
      continue
    }
    if (contract.behavior === 'persistent' && motion.loop !== true) {
      errors.push(`${action} must be looped`)
    }
    if (contract.behavior === 'one-shot' && motion.loop === true) {
      errors.push(`${action} must not be looped`)
    }
    if (contract.restoreStateAfterMs === 'required') {
      const restoreStateAfterMs = motion.restoreStateAfterMs
      if (restoreStateAfterMs === undefined ||
        !Number.isInteger(restoreStateAfterMs) || restoreStateAfterMs <= 0) {
        errors.push(`${action} requires a positive restoreStateAfterMs`)
      }
    } else if (motion.restoreStateAfterMs !== undefined) {
      errors.push(`${action} must not set restoreStateAfterMs`)
    }
  }
  return errors
}
