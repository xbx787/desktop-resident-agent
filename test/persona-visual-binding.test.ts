import { describe, expect, it } from 'vitest'
import { PERSONA_PRESETS } from '../src/shared/personas'
import { avatarRigFor } from '../src/renderer/avatar-rig'
import { live2dManifestForBinding } from '../src/renderer/live2d-manifest'
import {
  LIVE2D_DEV_PREVIEW_BINDING,
  personaVisualBindingFor,
  resolvePersonaVisualSelection
} from '../src/renderer/persona-visual-binding'

describe('persona visual binding', () => {
  it('falls back to each persona own sprite when no authorized Live2D model is bound', () => {
    for (const persona of PERSONA_PRESETS) {
      const binding = personaVisualBindingFor(persona.id)
      const selection = resolvePersonaVisualSelection(persona.id, 'bound-live2d')
      expect(binding.personaId).toBe(persona.id)
      expect(binding.spriteFallbackRigId).toBe(persona.id)
      expect(binding.live2d).toBeNull()
      expect(selection).toMatchObject({ source: 'sprite', live2d: null })
      expect(avatarRigFor(binding.spriteFallbackRigId).body).toBeTruthy()
      expect(avatarRigFor(binding.spriteFallbackRigId).avatar).toBeTruthy()
      expect(live2dManifestForBinding(selection.live2d)).toBeNull()
    }
  })

  it('uses Arch-chan only through the explicit development preview binding', () => {
    const normal = resolvePersonaVisualSelection('rin', 'sprite')
    const preview = resolvePersonaVisualSelection('rin', 'live2d-dev-preview')
    expect(normal.live2d).toBeNull()
    expect(preview.live2d).toBe(LIVE2D_DEV_PREVIEW_BINDING)
    expect(preview.source).toBe('dev-preview')
    expect(live2dManifestForBinding(preview.live2d)).toMatchObject({
      id: 'arch-chan',
      performanceProfileId: 'arch-chan-state-preview'
    })
  })

  it('fails unknown persona ids back to XiaoJing without inventing a model binding', () => {
    expect(personaVisualBindingFor('missing')).toEqual({
      personaId: 'xiaojing',
      spriteFallbackRigId: 'xiaojing',
      live2d: null
    })
  })
})
