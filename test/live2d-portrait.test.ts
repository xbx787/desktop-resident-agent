import { describe, expect, it } from 'vitest'
import type { AvatarLanes } from '../src/renderer/avatar-lanes'
import { live2dActionCandidates, live2dActionForLanes } from '../src/renderer/Live2DPortrait'
import { resolveLocalLive2DResource } from '../src/renderer/live2d-manifest'

describe('Live2DPortrait resource boundary', () => {
  const fileBase = 'file:///D:/DesktopPetProject/out/renderer/avatar.html'
  const webBase = 'http://localhost:5173/avatar.html'

  it('accepts bundled Cubism resources below the local live2d tree', () => {
    expect(resolveLocalLive2DResource('./live2d/arch-chan/arch%20chan%20model0.model3.json', fileBase, 'model'))
      .toBe('file:///D:/DesktopPetProject/out/renderer/live2d/arch-chan/arch%20chan%20model0.model3.json')
    expect(resolveLocalLive2DResource('/live2d/core/live2dcubismcore.min.js', webBase, 'core'))
      .toBe('http://localhost:5173/live2d/core/live2dcubismcore.min.js')
  })

  it('rejects CDNs, traversal and mismatched resource types', () => {
    expect(resolveLocalLive2DResource('https://cdn.example.test/model.model3.json', webBase, 'model')).toBeNull()
    expect(resolveLocalLive2DResource('../live2d/model.model3.json', fileBase, 'model')).toBeNull()
    expect(resolveLocalLive2DResource('./live2d/model.model3.json', fileBase, 'core')).toBeNull()
    expect(resolveLocalLive2DResource('./live2d/core/live2dcubismcore.min.js', fileBase, 'model')).toBeNull()
  })
})

describe('Live2D semantic action selection', () => {
  it('maps every task lane, while voice and drag take precedence', () => {
    const taskActions: Record<AvatarLanes['task'], ReturnType<typeof live2dActionForLanes>> = {
      idle: 'idle',
      received: 'acknowledge',
      planning: 'thinking',
      compacting: 'thinking',
      waiting: 'waiting',
      executing: 'working',
      verifying: 'verifying',
      completed: 'success',
      failed: 'failure',
      cancelled: 'failure'
    }

    for (const [task, expected] of Object.entries(taskActions) as Array<
      [AvatarLanes['task'], ReturnType<typeof live2dActionForLanes>]
    >) {
      expect(live2dActionForLanes({ task, work: 'none', voice: 'silent', interaction: 'none' })).toBe(expected)
    }
    expect(live2dActionForLanes({ task: 'executing', work: 'reading', voice: 'listening', interaction: 'none' }))
      .toBe('listening')
    expect(live2dActionForLanes({ task: 'executing', work: 'reading', voice: 'speaking', interaction: 'none' }))
      .toBe('speaking')
    expect(live2dActionForLanes({ task: 'executing', work: 'reading', voice: 'speaking', interaction: 'dragging' }))
      .toBeNull()
  })

  it('selects tool-specific actions and falls back to the generic work loop', () => {
    expect(live2dActionForLanes({ task: 'executing', work: 'reading', voice: 'silent', interaction: 'none' }))
      .toBe('reading')
    expect(live2dActionForLanes({ task: 'executing', work: 'other', voice: 'silent', interaction: 'none' }))
      .toBe('working')
    expect(live2dActionCandidates('searching')).toEqual(['searching', 'working', 'thinking', 'idle'])
  })

  it('uses the authored poke cue before compatibility fallbacks', () => {
    expect(live2dActionCandidates('poke')).toEqual(['poke', 'acknowledge', 'idle'])
  })
})
