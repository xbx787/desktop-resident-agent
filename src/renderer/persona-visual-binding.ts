import type { AvatarRenderer } from '../shared/contracts'
import { personaById } from '../shared/personas'
import type { Live2DModelId } from './live2d-model-catalog'
import type { Live2DPerformanceProfileId } from './live2d-performance-profiles'

export interface PersonaLive2DBinding {
  readonly modelId: Live2DModelId
  readonly profileId: Live2DPerformanceProfileId
}

export interface PersonaVisualBinding {
  readonly personaId: string
  readonly spriteFallbackRigId: string
  /** Absent until this persona has an authorized, matching model. */
  readonly live2d: PersonaLive2DBinding | null
}

export type PersonaVisualMode = 'sprite' | 'bound-live2d' | 'live2d-dev-preview'

export interface ResolvedPersonaVisualSelection {
  readonly persona: PersonaVisualBinding
  readonly live2d: PersonaLive2DBinding | null
  readonly source: 'sprite' | 'persona-live2d' | 'dev-preview'
}

const bindings: Readonly<Record<string, PersonaVisualBinding>> = {
  xiaojing: { personaId: 'xiaojing', spriteFallbackRigId: 'xiaojing', live2d: null },
  rin: { personaId: 'rin', spriteFallbackRigId: 'rin', live2d: null },
  rem: { personaId: 'rem', spriteFallbackRigId: 'rem', live2d: null },
  yui: { personaId: 'yui', spriteFallbackRigId: 'yui', live2d: null },
  yukino: { personaId: 'yukino', spriteFallbackRigId: 'yukino', live2d: null }
}

/** Explicit development fixture. It must never be inferred from a persona. */
export const LIVE2D_DEV_PREVIEW_BINDING: PersonaLive2DBinding = Object.freeze({
  modelId: 'arch-chan',
  profileId: 'arch-chan-state-preview'
})

export function personaVisualBindingFor(personaId?: string | null): PersonaVisualBinding {
  const id = personaById(personaId).id
  return bindings[id] ?? bindings.xiaojing
}

export function resolvePersonaVisualSelection(
  personaId: string | null | undefined,
  mode: PersonaVisualMode
): ResolvedPersonaVisualSelection {
  const persona = personaVisualBindingFor(personaId)
  if (mode === 'live2d-dev-preview') {
    return { persona, live2d: LIVE2D_DEV_PREVIEW_BINDING, source: 'dev-preview' }
  }
  if (mode === 'bound-live2d' && persona.live2d) {
    return { persona, live2d: persona.live2d, source: 'persona-live2d' }
  }
  return { persona, live2d: null, source: 'sprite' }
}

/** Map the persisted v0.0.88 setting to the explicit visual mode. */
export function personaVisualModeForRenderer(renderer: AvatarRenderer): PersonaVisualMode {
  return renderer === 'live2d-preview' ? 'live2d-dev-preview' : 'sprite'
}
