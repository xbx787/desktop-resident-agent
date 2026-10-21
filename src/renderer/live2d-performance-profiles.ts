import type { Live2DModelDefinition, Live2DModelId } from './live2d-model-catalog'

export type Live2DAction =
  | 'idle'
  | 'acknowledge'
  | 'thinking'
  | 'working'
  | 'success'
  | 'failure'

export type Live2DMotionPriority = 'idle' | 'normal' | 'force'

export interface Live2DMotionReference {
  readonly group: string
  readonly index: number
  readonly priority: Live2DMotionPriority
  /** Persistent state motions opt in because pixi-live2d-display 0.4.0 does
   * not apply motion3 Meta.Loop to CubismMotion automatically. */
  readonly loop?: boolean
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
      success: { group: 'Success', index: 0, priority: 'force' },
      failure: { group: 'Failure', index: 0, priority: 'force' }
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
    }
  }
  return errors
}
