import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isLocalLive2DResource,
  live2dModelFor,
  live2dManifestFor,
  live2dModelIds,
  resolveLocalLive2DResource,
  validateLive2DModelDefinition,
  validateLive2DPerformanceProfile,
  type Live2DPerformanceProfile
} from '../src/renderer/live2d-manifest'

describe('Live2D resource manifest', () => {
  it('matches every declared capability to the actual bundled model3', () => {
    for (const id of live2dModelIds) {
      const model = live2dModelFor(id)!
      const document = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../resources', model.modelResource), 'utf8')) as {
        FileReferences: {
          Motions?: Record<string, unknown[]>
          Expressions?: Array<{ Name: string }>
        }
        Groups?: Array<{ Target: string; Name: string; Ids: string[] }>
        HitAreas?: Array<{ Name: string }>
      }
      expect(model.capabilities.motions).toEqual(Object.fromEntries(
        Object.entries(document.FileReferences.Motions ?? {}).map(([group, entries]) => [group, entries.length])
      ))
      expect([...model.capabilities.expressions].sort()).toEqual(
        (document.FileReferences.Expressions ?? []).map((entry) => entry.Name).sort()
      )
      const parameters = (name: string) => (document.Groups ?? [])
        .filter((group) => group.Target === 'Parameter' && group.Name === name)
        .flatMap((group) => group.Ids).sort()
      expect([...model.capabilities.eyeBlinkParameters].sort()).toEqual(parameters('EyeBlink'))
      expect([...model.capabilities.lipSyncParameters].sort()).toEqual(parameters('LipSync'))
      expect([...model.capabilities.hitAreas].sort()).toEqual((document.HitAreas ?? []).map((entry) => entry.Name).sort())
    }
  })

  it('contains only local, bundled resources', () => {
    expect(live2dModelIds).toEqual(['arch-chan'])
    for (const id of live2dModelIds) {
      const manifest = live2dManifestFor(id)
      expect(manifest).not.toBeNull()
      expect(isLocalLive2DResource(manifest!.modelResource)).toBe(true)
      expect(isLocalLive2DResource(manifest!.coreResource)).toBe(true)
      expect(validateLive2DModelDefinition(manifest!)).toEqual([])
      expect(manifest!.licenses.model).toMatchObject({ id: 'CC0-1.0', distribution: 'bundled' })
      expect(manifest!.licenses.core.id).toBe('LicenseRef-Live2D-Cubism-Core')
    }
  })

  it('validates semantic motion groups and indices against model capabilities', () => {
    const model = live2dModelFor('arch-chan')!
    const valid = live2dManifestFor('arch-chan')!
    expect(validateLive2DPerformanceProfile(model, {
      id: valid.performanceProfileId,
      modelId: model.id,
      motions: valid.motions
    })).toEqual([])

    const invalid: Live2DPerformanceProfile = {
      id: 'arch-chan-state-preview',
      modelId: 'arch-chan',
      motions: {
        idle: { group: 'Missing', index: 0, priority: 'idle' },
        working: { group: 'Working', index: 1, priority: 'normal' }
      }
    }
    expect(validateLive2DPerformanceProfile(model, invalid)).toEqual([
      'idle references unknown motion group Missing',
      'working references invalid motion index Working[1]'
    ])
  })

  it('encodes the bundled model filename against the renderer document', () => {
    const manifest = live2dManifestFor('arch-chan')!
    expect(resolveLocalLive2DResource(manifest.modelResource, 'file:///D:/Whale/avatar.html', 'model'))
      .toBe('file:///D:/Whale/live2d/arch-chan/arch%20chan%20model0.model3.json')
  })

  it('fails closed for network, parent-directory and Windows path inputs', () => {
    for (const input of [
      'https://example.invalid/model.model3.json',
      'live2d/../outside.model3.json',
      'live2d/%2e%2e/outside.model3.json',
      'live2d/%5coutside.model3.json',
      'live2d\\outside.model3.json',
      'C:/Users/owner/model.model3.json',
      'live2d/model.model3.json?remote=1'
    ]) {
      expect(isLocalLive2DResource(input)).toBe(false)
      expect(resolveLocalLive2DResource(input, 'file:///D:/Whale/avatar.html', 'model')).toBeNull()
    }
    expect(live2dManifestFor('file:///D:/outside.model3.json')).toBeNull()
  })
})
