#!/usr/bin/env node
/** Independent static validator for the generated Arch-chan Cubism state motions. */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateModelPackage } from './model-package.mjs'

const toolDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(toolDir, '../..')
const modelDir = path.join(projectRoot, 'resources', 'live2d', 'arch-chan')
const modelPath = path.join(modelDir, 'arch chan model0.model3.json')
const cdiPath = path.join(modelDir, 'Arch Chan Model0.cdi3.json')
const physicsPath = path.join(modelDir, 'Arch Chan Model0.physics3.json')
const expectedMotions = {
  Idle: { file: 'motions/idle.motion3.json', loop: true },
  Thinking: { file: 'motions/thinking.motion3.json', loop: true },
  Working: { file: 'motions/working.motion3.json', loop: true },
  Listening: { file: 'motions/listening.motion3.json', loop: true },
  Speaking: { file: 'motions/speaking.motion3.json', loop: true },
  Waiting: { file: 'motions/waiting.motion3.json', loop: true },
  Verifying: { file: 'motions/verifying.motion3.json', loop: true },
  Poke: { file: 'motions/poke.motion3.json', loop: false }
}
const EPSILON = 1e-6
const SLOPE_ABSOLUTE_TOLERANCE = 0.05
const SLOPE_RELATIVE_TOLERANCE = 0.01

function loadJson(target) {
  return JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/u, ''))
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function cubicValue(p0, p1, p2, p3, position) {
  const inverse = 1 - position
  return (
    inverse ** 3 * p0 +
    3 * inverse ** 2 * position * p1 +
    3 * inverse * position ** 2 * p2 +
    position ** 3 * p3
  )
}

function cubicExtrema(p0, p1, p2, p3) {
  const coefficientA = 3 * (-p0 + 3 * p1 - 3 * p2 + p3)
  const coefficientB = 2 * (3 * p0 - 6 * p1 + 3 * p2)
  const coefficientC = -3 * p0 + 3 * p1
  const roots = []
  if (Math.abs(coefficientA) <= EPSILON) {
    if (Math.abs(coefficientB) > EPSILON) roots.push(-coefficientC / coefficientB)
  } else {
    const discriminant = coefficientB ** 2 - 4 * coefficientA * coefficientC
    if (discriminant >= 0) {
      const squareRoot = Math.sqrt(discriminant)
      roots.push(
        (-coefficientB - squareRoot) / (2 * coefficientA),
        (-coefficientB + squareRoot) / (2 * coefficientA)
      )
    }
  }
  return roots.filter((root) => root > 0 && root < 1)
    .map((root) => cubicValue(p0, p1, p2, p3, root))
}

function parseCurve(curve, duration, restricted, errors, label) {
  const segments = curve.Segments
  const empty = { segmentCount: 0, pointCount: 0, start: null, end: null, startSlope: 0, endSlope: 0 }
  if (!Array.isArray(segments) || segments.length < 5) {
    errors.push(`${label}: Segments must contain a start point and at least one segment`)
    return empty
  }
  if (segments.some((value) => !finiteNumber(value))) {
    errors.push(`${label}: Segments contains a non-finite number`)
    return empty
  }

  const startTime = segments[0]
  const startValue = segments[1]
  let previousTime = startTime
  let previousValue = startValue
  let firstSlope = null
  let finalSlope = 0
  let segmentCount = 0
  let pointCount = 1
  let offset = 2
  const keyValues = [startValue]
  const extremaValues = []

  while (offset < segments.length) {
    const kind = segments[offset]
    if (!Number.isInteger(kind) || ![0, 1, 2, 3].includes(kind)) {
      errors.push(`${label}: unsupported segment type ${kind} at offset ${offset}`)
      break
    }
    segmentCount += 1
    let outgoing = 0
    let incoming = 0
    let endTime
    let endValue
    if (kind === 1) {
      if (offset + 6 >= segments.length) {
        errors.push(`${label}: truncated Bezier segment at offset ${offset}`)
        break
      }
      const control1Time = segments[offset + 1]
      const control1Value = segments[offset + 2]
      const control2Time = segments[offset + 3]
      const control2Value = segments[offset + 4]
      endTime = segments[offset + 5]
      endValue = segments[offset + 6]
      const validTimes = previousTime < control1Time && control1Time <= control2Time && control2Time < endTime
      if (!validTimes) errors.push(`${label}: Bezier control times leave their segment ending at ${endTime}`)
      if (restricted) {
        const third = (endTime - previousTime) / 3
        if (Math.abs(control1Time - (previousTime + third)) > 0.0015) {
          errors.push(`${label}: first restricted Bezier handle is not at one third`)
        }
        if (Math.abs(control2Time - (endTime - third)) > 0.0015) {
          errors.push(`${label}: second restricted Bezier handle is not at two thirds`)
        }
      }
      outgoing = control1Time === previousTime ? 0 : (control1Value - previousValue) / (control1Time - previousTime)
      incoming = endTime === control2Time ? 0 : (endValue - control2Value) / (endTime - control2Time)
      extremaValues.push(...cubicExtrema(previousValue, control1Value, control2Value, endValue))
      pointCount += 3
      offset += 7
    } else {
      if (offset + 2 >= segments.length) {
        errors.push(`${label}: truncated segment at offset ${offset}`)
        break
      }
      endTime = segments[offset + 1]
      endValue = segments[offset + 2]
      if (endTime <= previousTime) errors.push(`${label}: key times are not strictly increasing`)
      if (kind === 0) {
        outgoing = incoming = endTime === previousTime ? 0 : (endValue - previousValue) / (endTime - previousTime)
      }
      pointCount += 1
      offset += 3
    }
    if (firstSlope === null) firstSlope = outgoing
    finalSlope = incoming
    previousTime = endTime
    previousValue = endValue
    keyValues.push(endValue)
  }

  if (offset !== segments.length) errors.push(`${label}: segment array has trailing or truncated values`)
  if (Math.abs(startTime) > EPSILON) errors.push(`${label}: first key is at ${startTime}, expected 0`)
  if (Math.abs(previousTime - duration) > EPSILON) errors.push(`${label}: last key is at ${previousTime}, expected ${duration}`)
  if (extremaValues.length) {
    const minimum = Math.min(...keyValues)
    const maximum = Math.max(...keyValues)
    const outside = extremaValues.find((value) => value < minimum - 1e-5 || value > maximum + 1e-5)
    if (outside !== undefined) errors.push(`${label}: Bezier overshoots its key range at ${outside.toFixed(5)}`)
  }
  return {
    segmentCount,
    pointCount,
    start: startValue,
    end: previousValue,
    startSlope: firstSlope ?? 0,
    endSlope: finalSlope
  }
}

function main() {
  const packageResult = validateModelPackage(modelPath)
  if (packageResult.errors.length) {
    for (const error of packageResult.errors) console.error(`NG: ${error}`)
    return 1
  }
  console.log(`checked model package: ${packageResult.files.length} local file references`)
  const errors = []
  const model = loadJson(modelPath)
  const cdi = loadJson(cdiPath)
  const physics = loadJson(physicsPath)
  const knownParameters = new Set((cdi.Parameters ?? []).map((entry) => entry.Id))
  const physicsOutputs = new Set(
    (physics.PhysicsSettings ?? []).flatMap((setting) => setting.Output ?? [])
      .map((output) => output.Destination?.Id)
      .filter(Boolean)
  )
  const eyeBlinkParameters = new Set(
    (model.Groups ?? []).filter((group) => group.Name === 'EyeBlink').flatMap((group) => group.Ids ?? [])
  )
  const motions = model.FileReferences?.Motions ?? {}
  const resolvedModelDir = path.resolve(modelDir)

  for (const [group, expected] of Object.entries(expectedMotions)) {
    const expectedRelativePath = expected.file
    const entries = motions[group]
    if (!Array.isArray(entries) || entries.length !== 1) {
      errors.push(`${group}: expected exactly one motion entry`)
      continue
    }
    const relativePath = entries[0]?.File
    if (relativePath !== expectedRelativePath) {
      errors.push(`${group}: expected ${expectedRelativePath}, got ${relativePath}`)
      continue
    }
    const motionPath = path.resolve(modelDir, relativePath)
    if (!motionPath.startsWith(`${resolvedModelDir}${path.sep}`)) {
      errors.push(`${group}: motion path escapes the model directory`)
      continue
    }
    if (!fs.statSync(motionPath, { throwIfNoEntry: false })?.isFile()) {
      errors.push(`${group}: missing ${relativePath}`)
      continue
    }

    const document = loadJson(motionPath)
    const meta = document.Meta ?? {}
    const curves = document.Curves
    const label = path.basename(motionPath)
    if (document.Version !== 3) errors.push(`${label}: Version must be 3`)
    if (meta.Loop !== expected.loop) errors.push(`${label}: Meta.Loop must be ${expected.loop}`)
    const duration = meta.Duration
    if (!finiteNumber(duration) || duration <= 0) {
      errors.push(`${label}: Duration must be a positive finite number`)
      continue
    }
    if (!Array.isArray(curves) || !curves.length) {
      errors.push(`${label}: Curves must be a nonempty array`)
      continue
    }

    let segmentCount = 0
    let pointCount = 0
    const animated = new Set()
    for (const curve of curves) {
      const parameterId = curve.Id
      const curveLabel = `${label}/${parameterId ?? '?'}`
      if (curve.Target !== 'Parameter') {
        errors.push(`${curveLabel}: only Parameter curves are allowed`)
        continue
      }
      if (!knownParameters.has(parameterId)) errors.push(`${curveLabel}: parameter is absent from cdi3`)
      if (physicsOutputs.has(parameterId)) errors.push(`${curveLabel}: physics output parameters must not be animated directly`)
      animated.add(parameterId)
      const parsed = parseCurve(curve, duration, Boolean(meta.AreBeziersRestricted), errors, curveLabel)
      segmentCount += parsed.segmentCount
      pointCount += parsed.pointCount
      if (expected.loop && parsed.start !== null && Math.abs(parsed.start - parsed.end) > EPSILON) {
        errors.push(`${curveLabel}: loop seam changes value`)
      }
      if (expected.loop) {
        const slopeDifference = Math.abs(parsed.startSlope - parsed.endSlope)
        const slopeTolerance = SLOPE_ABSOLUTE_TOLERANCE + SLOPE_RELATIVE_TOLERANCE * Math.max(
          Math.abs(parsed.startSlope), Math.abs(parsed.endSlope)
        )
        if (slopeDifference > slopeTolerance) {
          errors.push(`${curveLabel}: loop seam changes velocity (${parsed.endSlope.toFixed(3)}/s -> ${parsed.startSlope.toFixed(3)}/s)`)
        }
      }
    }
    if (expected.loop && [...eyeBlinkParameters].some((parameterId) => !animated.has(parameterId))) {
      errors.push(`${label}: long loop must contain both EyeBlink parameter curves`)
    }
    for (const [field, actual] of [
      ['CurveCount', curves.length],
      ['TotalSegmentCount', segmentCount],
      ['TotalPointCount', pointCount]
    ]) {
      if (meta[field] !== actual) errors.push(`${label}: Meta.${field}=${meta[field]}, actual=${actual}`)
    }
    console.log(`checked ${label}: curves=${curves.length} segments=${segmentCount} points=${pointCount}`)
  }

  if (errors.length) {
    console.log('---')
    for (const error of errors) console.log(`NG: ${error}`)
    console.log(`NG: ${errors.length} violation(s)`)
    return 1
  }
  const loopCount = Object.values(expectedMotions).filter((motion) => motion.loop).length
  const oneShotCount = Object.keys(expectedMotions).length - loopCount
  console.log(`OK: ${loopCount} generated state loops and ${oneShotCount} generated one-shot motion passed independent validation`)
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
}
