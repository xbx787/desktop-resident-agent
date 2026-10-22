import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, '../tools/live2d-motion/model-package.mjs')).href
const { validateModelPackage } = await import(/* @vite-ignore */ moduleUrl) as {
  validateModelPackage: (modelPath: string) => { errors: string[]; files: Array<{ field: string; path: string }> }
}

const temporaryParent = path.resolve(import.meta.dirname, '../.tmp/live2d-model-package-tests')
const roots: string[] = []

function fixture() {
  mkdirSync(temporaryParent, { recursive: true })
  const root = mkdtempSync(path.join(temporaryParent, 'package-'))
  roots.push(root)
  const packageRoot = path.join(root, 'model')
  const modelPath = path.join(packageRoot, 'test.model3.json')
  const references = {
    Moc: 'model.moc3',
    Textures: ['textures/texture 00.png'],
    Physics: 'model.physics3.json',
    DisplayInfo: 'model.cdi3.json',
    Pose: 'model.pose3.json',
    Expressions: [{ Name: 'Smile', File: 'expressions/smile.exp3.json' }],
    Motions: { Idle: [{ File: 'motions/idle.motion3.json', Sound: 'sounds/idle.wav' }] }
  }
  for (const file of [
    references.Moc, ...references.Textures, references.Physics, references.DisplayInfo,
    references.Pose, references.Expressions[0].File,
    references.Motions.Idle[0].File, references.Motions.Idle[0].Sound
  ]) {
    const target = path.join(packageRoot, file)
    mkdirSync(path.dirname(target), { recursive: true })
    writeFileSync(target, 'fixture')
  }
  const save = () => writeFileSync(modelPath, JSON.stringify({ Version: 3, FileReferences: references }))
  save()
  return { root, packageRoot, modelPath, references, save }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const relative = path.relative(temporaryParent, root)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('unsafe test cleanup path')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('complete Cubism model packages', () => {
  it('checks every supported file reference, including expressions, pose and motion audio', () => {
    const input = fixture()
    const result = validateModelPackage(input.modelPath)
    expect(result.errors).toEqual([])
    expect(result.files).toHaveLength(8)
    expect(result.files.map((file) => file.field)).toContain('FileReferences.Motions["Idle"][0].Sound')
    input.references.Textures[0] = 'textures/texture%2000.png'
    input.save()
    expect(validateModelPackage(input.modelPath).errors).toEqual([])
  })

  it.each([
    ['expressions/smile.exp3.json', 'FileReferences.Expressions[0].File'],
    ['textures/texture 00.png', 'FileReferences.Textures[0]'],
    ['sounds/idle.wav', 'FileReferences.Motions["Idle"][0].Sound'],
    ['model.pose3.json', 'FileReferences.Pose']
  ])('names the field and missing referenced file %s', (file, field) => {
    const input = fixture()
    rmSync(path.join(input.packageRoot, file))
    expect(validateModelPackage(input.modelPath).errors).toEqual([
      `${field} (${JSON.stringify(file)}): referenced file is missing`
    ])
  })

  it.each([
    'https://example.invalid/model.moc3', '//server/share/model.moc3',
    '/outside/model.moc3', 'C:/outside/model.moc3', 'C:model.moc3',
    'folder\\model.moc3', '../outside.moc3', 'folder/../../outside.moc3',
    '%2e%2e/outside.moc3', '%252e%252e/outside.moc3', '%2foutside.moc3',
    'folder/%2e%2e/outside.moc3', '%5coutside.moc3', 'model.moc3?url=1',
    'model.moc3#fragment', 'model%00.moc3', 'model%.moc3', ''
  ])('rejects unsafe references before reading: %s', (reference) => {
    const input = fixture()
    input.references.Moc = reference
    input.save()
    const errors = validateModelPackage(input.modelPath).errors
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain(`FileReferences.Moc (${JSON.stringify(reference)})`)
    expect(errors[0]).toContain('expected a local relative file path')
  })

  it.each(['empty', 'directory'])('rejects a %s resource', (kind) => {
    const input = fixture()
    const target = path.join(input.packageRoot, input.references.Moc)
    if (kind === 'directory') {
      rmSync(target)
      mkdirSync(target)
    } else writeFileSync(target, '')
    expect(validateModelPackage(input.modelPath).errors).toEqual([
      'FileReferences.Moc ("model.moc3"): expected a nonempty regular file'
    ])
  })

  it('rejects directory links that escape the model package', () => {
    const input = fixture()
    const outside = path.join(input.root, 'outside')
    mkdirSync(outside)
    writeFileSync(path.join(outside, 'external.moc3'), 'outside')
    symlinkSync(outside, path.join(input.packageRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    input.references.Moc = 'linked/external.moc3'
    input.save()
    expect(validateModelPackage(input.modelPath).errors).toEqual([
      'FileReferences.Moc ("linked/external.moc3"): resolved path escapes the model package'
    ])
  })

  it('rejects missing required fields and malformed optional groups', () => {
    const input = fixture()
    writeFileSync(input.modelPath, JSON.stringify({ Version: 3, FileReferences: {
      Textures: [], Expressions: {}, Motions: { Idle: {} }, Pose: null
    } }))
    const errors = validateModelPackage(input.modelPath).errors
    expect(errors).toHaveLength(5)
    for (const field of ['Moc', 'Textures', 'Expressions', 'Motions', 'Pose']) {
      expect(errors.some((error) => error.includes(`FileReferences.${field}`))).toBe(true)
    }
  })

  it('reports malformed model JSON without throwing', () => {
    const input = fixture()
    writeFileSync(input.modelPath, '{ invalid')
    const result = validateModelPackage(input.modelPath)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('model3 ("test.model3.json")')
    expect(result.files).toEqual([])
  })
})
