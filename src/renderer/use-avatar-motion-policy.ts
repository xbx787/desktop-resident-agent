import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AvatarLanes } from './avatar-lanes'
import {
  reduceAvatarMotionPolicy,
  type AvatarMotionPolicyState
} from './avatar-motion-policy'

interface LatestMotionInput {
  identity: string | null
  lanes: AvatarLanes
}

function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}

/** React bridge for the pure motion reducer. Layout effects apply urgent lane
 * changes before paint; a single timer wakes delayed task transitions. */
export function useAvatarMotionPolicy(identity: string | null, raw: AvatarLanes): AvatarLanes {
  const latest = useRef<LatestMotionInput>({ identity, lanes: raw })
  latest.current = { identity, lanes: raw }
  const [policy, setPolicy] = useState<AvatarMotionPolicyState | null>(null)

  useLayoutEffect(() => {
    setPolicy((previous) => reduceAvatarMotionPolicy(previous, {
      identity,
      lanes: raw,
      now: monotonicNow()
    }).state)
  }, [identity, raw.task, raw.work, raw.voice, raw.interaction, raw.emotion])

  const wakeAt = policy?.pending?.applyAt ?? null
  useEffect(() => {
    if (wakeAt === null) return
    const delay = Math.max(0, Math.ceil(wakeAt - monotonicNow()))
    const timer = window.setTimeout(() => {
      const current = latest.current
      setPolicy((previous) => reduceAvatarMotionPolicy(previous, {
        identity: current.identity,
        lanes: current.lanes,
        // Timers may fire a fraction early. The scheduled transition is due
        // by definition, so avoid leaving an identical wakeAt unscheduled.
        now: Math.max(monotonicNow(), wakeAt)
      }).state)
    }, delay)
    return () => window.clearTimeout(timer)
  }, [wakeAt])

  if (!policy || policy.identity !== identity) return raw
  return policy.visible
}
