/**
 * Compatibility facade for the v0.0.88 renderer. Models, performance maps and
 * persona bindings now live in separate modules, while existing callers can
 * continue consuming one validated manifest.
 */
import {
  live2dModelFor,
  live2dModelIds,
  validateLive2DModelDefinition,
  type Live2DModelDefinition,
  type Live2DModelId
} from './live2d-model-catalog'
import {
  live2dPerformanceProfileFor,
  validateLive2DPerformanceProfile,
  type Live2DPerformanceProfileId,
  type Live2DMotionReference,
  type Live2DAction
} from './live2d-performance-profiles'
import type { PersonaLive2DBinding } from './persona-visual-binding'

export type {
  Live2DAssetLicense,
  Live2DModelCapabilities,
  Live2DModelDefinition,
  Live2DModelId,
  Live2DResourceKind
} from './live2d-model-catalog'
export {
  isLocalLive2DResource,
  live2dModelFor,
  live2dModelIds,
  resolveLocalLive2DResource,
  validateLive2DModelDefinition
} from './live2d-model-catalog'
export type {
  Live2DAction,
  Live2DMotionPriority,
  Live2DMotionReference,
  Live2DPerformanceProfile,
  Live2DPerformanceProfileId
} from './live2d-performance-profiles'
export {
  live2dPerformanceProfileFor,
  validateLive2DPerformanceProfile
} from './live2d-performance-profiles'

export interface Live2DModelManifest extends Live2DModelDefinition {
  readonly performanceProfileId: Live2DPerformanceProfileId
  readonly motions: Readonly<Partial<Record<Live2DAction, Live2DMotionReference>>>
}

const defaultProfiles: Readonly<Record<Live2DModelId, Live2DPerformanceProfileId>> = {
  'arch-chan': 'arch-chan-state-preview'
}

function buildManifest(modelId: Live2DModelId, profileId: Live2DPerformanceProfileId): Live2DModelManifest | null {
  const model = live2dModelFor(modelId)
  const profile = live2dPerformanceProfileFor(profileId)
  if (!model || !profile) return null
  if (validateLive2DModelDefinition(model).length || validateLive2DPerformanceProfile(model, profile).length) return null
  return Object.freeze({ ...model, performanceProfileId: profile.id, motions: profile.motions })
}

const manifests = new Map<string, Live2DModelManifest>()
for (const modelId of live2dModelIds) {
  const profileId = defaultProfiles[modelId]
  const manifest = buildManifest(modelId, profileId)
  if (manifest) manifests.set(`${modelId}:${profileId}`, manifest)
}

/** Returns null instead of accepting an arbitrary model id, URL or path. */
export function live2dManifestFor(id: string | null | undefined): Live2DModelManifest | null {
  const model = live2dModelFor(id)
  if (!model) return null
  return manifests.get(`${model.id}:${defaultProfiles[model.id]}`) ?? null
}

/** Resolve an explicit persona/preview binding into a validated manifest. */
export function live2dManifestForBinding(binding: PersonaLive2DBinding | null): Live2DModelManifest | null {
  if (!binding) return null
  const key = `${binding.modelId}:${binding.profileId}`
  const cached = manifests.get(key)
  if (cached) return cached
  const manifest = buildManifest(binding.modelId, binding.profileId)
  if (manifest) manifests.set(key, manifest)
  return manifest
}
