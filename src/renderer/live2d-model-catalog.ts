/**
 * Bundled Live2D resources are declared in this catalog. Renderer state,
 * personas and persisted settings may select an id, but they may never supply
 * an arbitrary URL or filesystem path.
 */
export type Live2DModelId = 'arch-chan'

export type Live2DResourceKind = 'model' | 'core'

export interface Live2DAssetLicense {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly distribution: 'bundled' | 'local-only'
  readonly noticeResource: string
}

export interface Live2DModelCapabilities {
  /**
   * Whether the existing DOM avatar target may pass hover coordinates to
   * `Live2DModel.focus`. This is deliberately opt-in per model: importing a
   * model with face-angle parameters alone must never make it interactive.
   */
  readonly pointerFocus: boolean
  /** Motion group name to the number of authored motions in that group. */
  readonly motions: Readonly<Record<string, number>>
  readonly expressions: readonly string[]
  readonly lipSyncParameters: readonly string[]
  readonly eyeBlinkParameters: readonly string[]
  readonly hitAreas: readonly string[]
}

export interface Live2DModelDefinition {
  readonly id: Live2DModelId
  /** Internal label only. It is intentionally not surfaced as a persona. */
  readonly label: string
  readonly modelResource: string
  readonly coreResource: string
  readonly capabilities: Live2DModelCapabilities
  readonly licenses: {
    readonly model: Live2DAssetLicense
    readonly core: Live2DAssetLicense
  }
}

const LOCAL_RESOURCE_PREFIX = 'live2d/'

const modelCatalog: Readonly<Record<Live2DModelId, Live2DModelDefinition>> = {
  // CC0 technical preview only. It remains a renderer regression fixture and
  // is not a XiaoJing model or a persona asset.
  'arch-chan': {
    id: 'arch-chan',
    label: 'Arch-chan technical preview',
    modelResource: 'live2d/arch-chan/arch chan model0.model3.json',
    coreResource: 'live2d/core/live2dcubismcore.min.js',
    capabilities: {
      // The technical fixture has the standard Cubism face-angle parameters.
      // It can therefore demonstrate DOM-owned hover focus without enabling
      // Pixi interaction or representing a XiaoJing production capability.
      pointerFocus: true,
      motions: {
        Idle: 1,
        Acknowledge: 1,
        Thinking: 1,
        Working: 1,
        Success: 1,
        Failure: 1
      },
      expressions: ['Mouse.exp3.json'],
      lipSyncParameters: [],
      eyeBlinkParameters: ['ParamEyeLOpen', 'ParamEyeROpen'],
      hitAreas: []
    },
    licenses: {
      model: {
        id: 'CC0-1.0',
        name: 'CC0 1.0 Universal',
        source: 'https://github.com/Speykious/arch-chan',
        distribution: 'bundled',
        noticeResource: 'live2d/arch-chan/LICENSE.md'
      },
      core: {
        id: 'LicenseRef-Live2D-Cubism-Core',
        name: 'Live2D Proprietary Software License Agreement',
        source: 'https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html',
        distribution: 'bundled',
        noticeResource: 'live2d/NOTICE.md'
      }
    }
  }
}

export const live2dModelIds: readonly Live2DModelId[] = Object.freeze(
  Object.keys(modelCatalog) as Live2DModelId[]
)

export function live2dModelFor(id: string | null | undefined): Live2DModelDefinition | null {
  if (!id || !Object.prototype.hasOwnProperty.call(modelCatalog, id)) return null
  return modelCatalog[id as Live2DModelId]
}

/** True only for a relative or renderer-root path inside bundled `live2d/`. */
export function isLocalLive2DResource(resource: string): boolean {
  const clean = resource.trim()
  if (!clean || clean.includes('\\') || clean.includes('\0') || clean.includes('?') || clean.includes('#')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return false
  if (/%(?:2f|5c|00)/i.test(clean)) return false

  let decoded: string
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    return false
  }
  if (decoded.includes('\\') || decoded.includes('\0')) return false
  const relative = decoded.replace(/^\.?\//u, '')
  if (relative.split('/').some((part) => part === '..')) return false
  return relative.startsWith(LOCAL_RESOURCE_PREFIX)
}

/**
 * Resolve an entry in the compiled renderer's adjacent `live2d` folder.
 * `kind` pins the expected file type so a catalog edit cannot point a model
 * slot at the Core script or vice versa.
 */
export function resolveLocalLive2DResource(
  resource: string,
  baseUrl: string,
  kind: Live2DResourceKind
): string | null {
  const clean = resource.trim()
  if (!isLocalLive2DResource(clean)) return null

  let url: URL
  try {
    url = new URL(clean, baseUrl)
  } catch {
    return null
  }
  if (url.protocol !== 'file:' && url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.pathname.includes(`/${LOCAL_RESOURCE_PREFIX}`) || url.pathname.includes('/../')) return null

  const pathname = url.pathname.toLowerCase()
  if (kind === 'model' && !pathname.endsWith('.model3.json')) return null
  if (kind === 'core' && !pathname.endsWith('/live2dcubismcore.min.js')) return null
  return url.href
}

export function validateLive2DModelDefinition(model: Live2DModelDefinition): readonly string[] {
  const errors: string[] = []
  if (!isLocalLive2DResource(model.modelResource) || !model.modelResource.toLowerCase().endsWith('.model3.json')) {
    errors.push('modelResource must be a bundled .model3.json path')
  }
  if (!isLocalLive2DResource(model.coreResource) || !model.coreResource.toLowerCase().endsWith('/live2dcubismcore.min.js')) {
    errors.push('coreResource must be the bundled Cubism Core path')
  }
  if (typeof model.capabilities.pointerFocus !== 'boolean') {
    errors.push('pointerFocus capability must be explicitly declared')
  }
  for (const [group, count] of Object.entries(model.capabilities.motions)) {
    if (!group.trim() || !Number.isInteger(count) || count < 0) errors.push(`invalid motion capability: ${group}`)
  }
  for (const [kind, license] of Object.entries(model.licenses)) {
    if (!license.id.trim() || !license.name.trim() || !license.source.trim() || !license.noticeResource.trim()) {
      errors.push(`${kind} license metadata is incomplete`)
    }
  }
  return errors
}
