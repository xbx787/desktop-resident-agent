import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { live2dManifestFor, type Live2DAction } from '../src/renderer/live2d-manifest'

interface MotionCurve {
  Target: string
  Id: string
  Segments: number[]
}

interface MotionJson {
  Version: number
  Meta: {
    Duration: number
    Loop: boolean
    AreBeziersRestricted: boolean
    CurveCount: number
    TotalSegmentCount: number
    TotalPointCount: number
  }
  Curves: MotionCurve[]
}

const root = path.resolve(import.meta.dirname, '..')
const modelDir = path.join(root, 'resources', 'live2d', 'arch-chan')
const model = JSON.parse(fs.readFileSync(path.join(modelDir, 'arch chan model0.model3.json'), 'utf8')) as {
  FileReferences: { Motions: Record<string, Array<{ File: string }>> }
  Groups: Array<{ Name: string; Ids: string[] }>
}
const cdi = JSON.parse(fs.readFileSync(path.join(modelDir, 'Arch Chan Model0.cdi3.json'), 'utf8')) as {
  Parameters: Array<{ Id: string }>
}

interface Point {
  time: number
  value: number
}

interface CubicSegment {
  start: Point
  control1: Point
  control2: Point
  end: Point
}

interface ParsedCurve {
  start: Point
  end: Point
  segmentCount: number
  pointCount: number
  cubics: CubicSegment[]
}

function parseCurve(segments: number[]): ParsedCurve {
  expect(segments.length).toBeGreaterThanOrEqual(5)
  const cubics: CubicSegment[] = []
  let start: Point = { time: segments[0], value: segments[1] }
  const initial = start
  let segmentCount = 0
  let pointCount = 1
  for (let offset = 2; offset < segments.length;) {
    const kind = segments[offset]
    if (kind === 1) {
      expect(offset + 6).toBeLessThan(segments.length)
      const segment: CubicSegment = {
        start,
        control1: { time: segments[offset + 1], value: segments[offset + 2] },
        control2: { time: segments[offset + 3], value: segments[offset + 4] },
        end: { time: segments[offset + 5], value: segments[offset + 6] }
      }
      expect(segment.start.time).toBeLessThan(segment.control1.time)
      expect(segment.control1.time).toBeLessThanOrEqual(segment.control2.time)
      expect(segment.control2.time).toBeLessThan(segment.end.time)
      cubics.push(segment)
      start = segment.end
      segmentCount += 1
      pointCount += 3
      offset += 7
      continue
    }
    expect(kind, '非循环动作只能使用标准线性段').toBe(0)
    expect(offset + 2).toBeLessThan(segments.length)
    const end: Point = { time: segments[offset + 1], value: segments[offset + 2] }
    expect(start.time).toBeLessThan(end.time)
    start = end
    segmentCount += 1
    pointCount += 1
    offset += 3
  }
  return { start: initial, end: start, segmentCount, pointCount, cubics }
}

function slopeAtStart(segment: CubicSegment): number {
  return (segment.control1.value - segment.start.value) / (segment.control1.time - segment.start.time)
}

function slopeAtEnd(segment: CubicSegment): number {
  return (segment.end.value - segment.control2.value) / (segment.end.time - segment.control2.time)
}

describe('Arch-chan Live2D state motion fixtures', () => {
  it('matches the checked-in Node generator and independent Node validator', () => {
    const generator = path.join(root, 'tools', 'live2d-motion', 'generate.mjs')
    const validator = path.join(root, 'tools', 'live2d-motion', 'validate.mjs')
    const generated = execFileSync(process.execPath, [generator, '--check'], { cwd: root, encoding: 'utf8' })
    const validated = execFileSync(process.execPath, [validator], { cwd: root, encoding: 'utf8' })
    expect(generated).toContain('OK: resources')
    expect(validated).toContain('OK: 3 generated state loops passed independent validation')
  })

  it('covers every application action with an existing model motion', () => {
    const manifest = live2dManifestFor('arch-chan')!
    const actions: Live2DAction[] = ['idle', 'acknowledge', 'thinking', 'working', 'success', 'failure']
    expect(Object.keys(manifest.motions).sort()).toEqual([...actions].sort())

    for (const action of actions) {
      const reference = manifest.motions[action]!
      const definitions = model.FileReferences.Motions[reference.group]
      expect(definitions, `${action} 缺少 ${reference.group} 组`).toBeDefined()
      expect(definitions[reference.index]).toBeDefined()
      expect(fs.existsSync(path.join(modelDir, definitions[reference.index].File))).toBe(true)
    }
  })

  it('uses known parameters, restricted Bezier metadata and C1 loop seams', () => {
    const manifest = live2dManifestFor('arch-chan')!
    const knownParameters = new Set(cdi.Parameters.map((parameter) => parameter.Id))

    for (const reference of Object.values(manifest.motions)) {
      if (!reference) continue
      const definition = model.FileReferences.Motions[reference.group][reference.index]
      const motion = JSON.parse(fs.readFileSync(path.join(modelDir, definition.File), 'utf8')) as MotionJson
      let segmentCount = 0
      let pointCount = 0

      expect(motion.Version).toBe(3)
      expect(motion.Meta.Loop).toBe(reference.loop === true)
      expect(motion.Meta.CurveCount).toBe(motion.Curves.length)
      if (reference.loop) {
        expect(motion.Meta.AreBeziersRestricted).toBe(true)
        const animated = new Set(motion.Curves.map((curve) => curve.Id))
        expect(animated.has('ParamEyeLOpen')).toBe(true)
        expect(animated.has('ParamEyeROpen')).toBe(true)
      }
      for (const curve of motion.Curves) {
        expect(curve.Target).toBe('Parameter')
        expect(knownParameters.has(curve.Id), `${definition.File} 使用未知参数 ${curve.Id}`).toBe(true)
        const parsed = parseCurve(curve.Segments)
        segmentCount += parsed.segmentCount
        pointCount += parsed.pointCount
        expect(parsed.start.time).toBe(0)
        expect(parsed.end.time).toBe(motion.Meta.Duration)
        if (reference.loop) {
          expect(parsed.cubics, `${definition.File}/${curve.Id} 的 loop 必须使用受限 Bezier 段`).toHaveLength(parsed.segmentCount)
          expect(parsed.end.value, `${definition.File}/${curve.Id} 会在结束时残留`).toBe(parsed.start.value)
          const startSlope = slopeAtStart(parsed.cubics[0])
          const endSlope = slopeAtEnd(parsed.cubics.at(-1)!)
          const tolerance = 0.05 + 0.01 * Math.max(Math.abs(startSlope), Math.abs(endSlope))
          expect(Math.abs(startSlope - endSlope), `${definition.File}/${curve.Id} 的 loop 接缝速度不连续`).toBeLessThanOrEqual(tolerance)
        }
      }
      expect(motion.Meta.TotalSegmentCount).toBe(segmentCount)
      expect(motion.Meta.TotalPointCount).toBe(pointCount)
    }

    expect(model.Groups.find((group) => group.Name === 'EyeBlink')?.Ids)
      .toEqual(['ParamEyeLOpen', 'ParamEyeROpen'])
  })
})
