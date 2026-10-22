import { describe, expect, it } from 'vitest'
import { live2dModelFor } from '../src/renderer/live2d-model-catalog'
import {
  live2dActionContracts,
  live2dPerformanceProfileFor,
  validateLive2DPerformanceProfile,
  type Live2DPerformanceProfile
} from '../src/renderer/live2d-performance-profiles'

describe('Live2D performance-profile action contracts', () => {
  it('declares every semantic action as either persistent or one-shot', () => {
    expect(live2dActionContracts).toEqual({
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
    })
  })

  it('accepts the authored Arch technical-preview profile', () => {
    const model = live2dModelFor('arch-chan')!
    const profile = live2dPerformanceProfileFor('arch-chan-state-preview')!

    expect(validateLive2DPerformanceProfile(model, profile)).toEqual([])
  })

  it('permits a capability-limited profile that maps only the motions it has', () => {
    const model = live2dModelFor('arch-chan')!
    const partial: Live2DPerformanceProfile = {
      id: 'arch-chan-state-preview',
      modelId: 'arch-chan',
      motions: {
        idle: { group: 'Idle', index: 0, priority: 'idle', loop: true }
      }
    }

    expect(validateLive2DPerformanceProfile(model, partial)).toEqual([])
  })

  it('rejects invalid loop and restore semantics without requiring a complete profile', () => {
    const model = live2dModelFor('arch-chan')!
    const invalid: Live2DPerformanceProfile = {
      id: 'arch-chan-state-preview',
      modelId: 'arch-chan',
      motions: {
        idle: { group: 'Idle', index: 0, priority: 'idle', loop: false },
        acknowledge: { group: 'Acknowledge', index: 0, priority: 'normal', loop: true },
        speaking: { group: 'Speaking', index: 0, priority: 'normal', loop: true, restoreStateAfterMs: 250 },
        poke: { group: 'Poke', index: 0, priority: 'force', restoreStateAfterMs: 0 }
      }
    }

    expect(validateLive2DPerformanceProfile(model, invalid)).toEqual([
      'idle must be looped',
      'acknowledge must not be looped',
      'speaking must not set restoreStateAfterMs',
      'poke requires a positive restoreStateAfterMs'
    ])
  })

  it('reports untrusted runtime profile keys instead of throwing', () => {
    const model = live2dModelFor('arch-chan')!
    const malformed = {
      id: 'arch-chan-state-preview',
      modelId: 'arch-chan',
      motions: {
        unexpected: { group: 'Idle', index: 0, priority: 'idle', loop: true }
      }
    } as unknown as Live2DPerformanceProfile

    expect(validateLive2DPerformanceProfile(model, malformed))
      .toEqual(['unexpected is not a known semantic action'])
  })
})
