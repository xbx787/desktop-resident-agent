import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runSelfTest } from '../src/main/self-test'

const roots: string[] = []

function fixture(): { dataRoot: string; rendererRoot: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'whale-self-test-'))
  roots.push(root)
  const rendererRoot = path.join(root, 'renderer')
  const modelDir = path.join(rendererRoot, 'live2d', 'arch-chan')
  mkdirSync(path.join(modelDir, 'motions'), { recursive: true })
  mkdirSync(path.join(modelDir, 'textures'), { recursive: true })
  mkdirSync(path.join(rendererRoot, 'live2d', 'core'), { recursive: true })
  writeFileSync(path.join(rendererRoot, 'avatar.html'), '<div id="root"></div>')
  for (const file of ['model.moc3', 'model.physics3.json', 'model.cdi3.json']) {
    writeFileSync(path.join(modelDir, file), '{}')
  }
  writeFileSync(path.join(modelDir, 'textures', 'texture_00.png'), 'png')
  writeFileSync(path.join(modelDir, 'motions', 'idle.motion3.json'), '{}')
  writeFileSync(path.join(modelDir, 'arch chan model0.model3.json'), JSON.stringify({
    FileReferences: {
      Moc: 'model.moc3',
      Physics: 'model.physics3.json',
      DisplayInfo: 'model.cdi3.json',
      Textures: ['textures/texture_00.png'],
      Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] }
    }
  }))
  writeFileSync(path.join(rendererRoot, 'live2d', 'core', 'live2dcubismcore.min.js'), 'x'.repeat(2_000))
  return { dataRoot: path.join(root, 'data'), rendererRoot }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('runSelfTest', () => {
  it('passes when windows, settings and every referenced Live2D file are present', () => {
    const input = fixture()
    const result = runSelfTest({ version: '0.0.87', ...input, windowsReady: true, settingsReady: true })
    expect(result.ok).toBe(true)
    expect(result.version).toBe('0.0.87')
    expect(result.checks.every((check) => check.ok)).toBe(true)
    expect(result.checks.map((check) => check.id)).toContain('live2d-model')
  })

  it('fails closed and names a missing model reference', () => {
    const input = fixture()
    rmSync(path.join(input.rendererRoot, 'live2d', 'arch-chan', 'motions', 'idle.motion3.json'))
    const result = runSelfTest({ version: '0.0.87', ...input, windowsReady: false, settingsReady: true })
    expect(result.ok).toBe(false)
    const model = result.checks.find((check) => check.id === 'live2d-model')
    expect(model?.ok).toBe(false)
    expect(model?.detail).toContain('idle.motion3.json')
    expect(result.checks.find((check) => check.id === 'windows')?.ok).toBe(false)
  })
})
