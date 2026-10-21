/**
 * Deterministic Cubism motion3 curve generation helpers.
 *
 * Adapted from shinshin86/live2d-add-motion-sample-web-ui tools/gen_motions.py,
 * pinned at e6e2df001553d59874a1cca1eabf247af2e6ea92. See UPSTREAM.md and LICENSE.
 */

export const FPS = 30

function rounded(value, places) {
  const factor = 10 ** places
  return Math.round((value + Number.EPSILON) * factor) / factor
}

/** Snap a time to the 30 fps grid used by the shipped motions. */
export function snap(time) {
  return rounded(Math.round(time * FPS) / FPS, 3)
}

function periodicSlopes(keys) {
  const intervals = keys.slice(1).map((right, index) => right[0] - keys[index][0])
  if (intervals.some((interval) => interval <= 0)) {
    throw new Error('curve key times must be strictly increasing')
  }
  const deltas = keys.slice(1).map((right, index) => (right[1] - keys[index][1]) / intervals[index])

  function slope(previousInterval, previousDelta, nextInterval, nextDelta) {
    if (previousDelta * nextDelta <= 0) return 0
    const previousWeight = 2 * nextInterval + previousInterval
    const nextWeight = nextInterval + 2 * previousInterval
    return (previousWeight + nextWeight) / (
      previousWeight / previousDelta + nextWeight / nextDelta
    )
  }

  const tangents = Array(keys.length).fill(0)
  for (let index = 1; index < keys.length - 1; index += 1) {
    tangents[index] = slope(
      intervals[index - 1], deltas[index - 1], intervals[index], deltas[index]
    )
  }
  const seamSlope = slope(intervals.at(-1), deltas.at(-1), intervals[0], deltas[0])
  tangents[0] = seamSlope
  tangents[tangents.length - 1] = seamSlope
  return tangents
}

/** Build a restricted-Bezier Parameter curve from readable keyframes. */
export function curve(parameterId, rawKeys, { loop }) {
  const keys = rawKeys.map(([time, value]) => [snap(time), rounded(value, 3)])
  if (keys.length < 2) throw new Error(`${parameterId}: a curve needs at least two keys`)
  if (loop && keys[0][1] !== keys.at(-1)[1]) {
    throw new Error(`${parameterId}: loop must end on its first value (${keys[0][1]}), got ${keys.at(-1)[1]}`)
  }

  const tangents = loop ? periodicSlopes(keys) : Array(keys.length).fill(0)
  const segments = [keys[0][0], keys[0][1]]
  for (let index = 0; index < keys.length - 1; index += 1) {
    const [time0, value0] = keys[index]
    const [time1, value1] = keys[index + 1]
    const slope0 = tangents[index]
    const slope1 = tangents[index + 1]
    const third = (time1 - time0) / 3
    const control1Time = rounded(time0 + third, 3)
    const control2Time = rounded(time1 - third, 3)
    const control1Value = slope0 ? rounded(value0 + slope0 * (control1Time - time0), 5) : value0
    const control2Value = slope1 ? rounded(value1 - slope1 * (time1 - control2Time), 5) : value1
    segments.push(1, control1Time, control1Value, control2Time, control2Value, time1, value1)
  }
  return { Target: 'Parameter', Id: parameterId, Segments: segments }
}

/** Build a complete motion3 document and derive all metadata counts. */
export function motion(duration, curves, { loop, fadeIn, fadeOut }) {
  const snappedDuration = snap(duration)
  let totalSegments = 0
  let totalPoints = 0
  for (const entry of curves) {
    const { Segments: segments } = entry
    totalPoints += 1
    for (let offset = 2; offset < segments.length;) {
      totalSegments += 1
      if (segments[offset] === 1) {
        totalPoints += 3
        offset += 7
      } else {
        totalPoints += 1
        offset += 3
      }
    }
  }
  return {
    Version: 3,
    Meta: {
      Duration: snappedDuration,
      Fps: FPS,
      FadeInTime: fadeIn,
      FadeOutTime: fadeOut,
      Loop: loop,
      AreBeziersRestricted: true,
      CurveCount: curves.length,
      TotalSegmentCount: totalSegments,
      TotalPointCount: totalPoints,
      UserDataCount: 0,
      TotalUserDataSize: 0
    },
    Curves: curves,
    UserData: []
  }
}
