import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AVATAR_BEHAVIOR_PROFILES,
  avatarBehaviorProfileFor,
  startAvatarBehaviorScheduler,
  type AvatarBehaviorProfile
} from '../src/renderer/avatar-behavior'

const twoBehaviors: AvatarBehaviorProfile = {
  initialDelayMs: [10, 10],
  gapMs: [10, 10],
  behaviors: [
    { id: 'blink', weight: 1, cooldownMs: 0, durationMs: [50, 50] },
    { id: 'fidget', weight: 1, cooldownMs: 0, durationMs: [80, 80] }
  ]
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function injectedTimers() {
  return {
    setTimeout: vi.fn((callback: () => void, delayMs: number) => globalThis.setTimeout(callback, delayMs)),
    clearTimeout: vi.fn((handle: ReturnType<typeof globalThis.setTimeout>) => globalThis.clearTimeout(handle))
  }
}

describe('avatar behaviour profiles', () => {
  it('uses a livelier profile for Yui and a more reserved one for Yukino', () => {
    const weight = (profile: AvatarBehaviorProfile, id: string) =>
      profile.behaviors.find((behavior) => behavior.id === id)?.weight ?? 0
    const cooldown = (profile: AvatarBehaviorProfile, id: string) =>
      profile.behaviors.find((behavior) => behavior.id === id)?.cooldownMs ?? 0

    expect(weight(AVATAR_BEHAVIOR_PROFILES.yui, 'fidget')).toBeGreaterThan(weight(AVATAR_BEHAVIOR_PROFILES.yukino, 'fidget'))
    expect(weight(AVATAR_BEHAVIOR_PROFILES.yui, 'expression')).toBeGreaterThan(weight(AVATAR_BEHAVIOR_PROFILES.yukino, 'expression'))
    expect(cooldown(AVATAR_BEHAVIOR_PROFILES.yukino, 'expression')).toBeGreaterThan(cooldown(AVATAR_BEHAVIOR_PROFILES.yui, 'expression'))
    expect(avatarBehaviorProfileFor('unknown')).toBe(AVATAR_BEHAVIOR_PROFILES.xiaojing)
  })
})

describe('startAvatarBehaviorScheduler', () => {
  it('runs only one action at a time and waits for cleanup before the next one', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const timers = injectedTimers()
    const events: string[] = []
    let active = 0
    let maximumActive = 0
    const rolls = [0, 0.999]
    const action = (name: string) => () => {
      active += 1
      maximumActive = Math.max(maximumActive, active)
      events.push(`start:${name}`)
      return () => {
        active -= 1
        events.push(`stop:${name}`)
      }
    }

    const stop = startAvatarBehaviorScheduler({
      profile: twoBehaviors,
      actions: { blink: action('blink'), fidget: action('fidget') },
      random: () => rolls.shift() ?? 0,
      now: Date.now,
      ...timers
    })

    vi.advanceTimersByTime(10)
    expect(events).toEqual(['start:blink'])
    vi.advanceTimersByTime(49)
    expect(events).toEqual(['start:blink'])
    vi.advanceTimersByTime(1)
    expect(events).toEqual(['start:blink', 'stop:blink'])
    vi.advanceTimersByTime(10)
    expect(events).toEqual(['start:blink', 'stop:blink', 'start:fidget'])
    expect(maximumActive).toBe(1)
    stop()
    expect(active).toBe(0)
  })

  it('waits until a behavior cooldown expires instead of starting it early', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const calls: number[] = []
    const profile: AvatarBehaviorProfile = {
      initialDelayMs: [5, 5],
      gapMs: [5, 5],
      behaviors: [{ id: 'blink', weight: 1, cooldownMs: 100, durationMs: [10, 10] }]
    }
    const stop = startAvatarBehaviorScheduler({
      profile,
      actions: { blink: () => { calls.push(Date.now()) } },
      random: () => 0,
      now: Date.now,
      ...injectedTimers()
    })

    vi.advanceTimersByTime(114)
    expect(calls).toEqual([5])
    vi.advanceTimersByTime(1)
    expect(calls).toEqual([5, 115])
    stop()
  })

  it('stop immediately cancels the active action and every pending timer', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const timers = injectedTimers()
    const cleanup = vi.fn()
    const fidget = vi.fn(() => cleanup)
    const stop = startAvatarBehaviorScheduler({
      profile: {
        initialDelayMs: [5, 5],
        gapMs: [5, 5],
        behaviors: [{ id: 'fidget', weight: 1, cooldownMs: 0, durationMs: [500, 500] }]
      },
      actions: { fidget },
      random: () => 0,
      now: Date.now,
      ...timers
    })

    vi.advanceTimersByTime(5)
    expect(fidget).toHaveBeenCalledTimes(1)
    stop()
    stop()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(timers.clearTimeout).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(2000)
    expect(fidget).toHaveBeenCalledTimes(1)
  })

  it('does not schedule or invoke actions when reduced motion is enabled', () => {
    const timers = injectedTimers()
    const blink = vi.fn()
    const stop = startAvatarBehaviorScheduler({
      personaId: 'xiaojing',
      actions: { blink },
      reducedMotion: true,
      ...timers
    })

    expect(timers.setTimeout).not.toHaveBeenCalled()
    expect(blink).not.toHaveBeenCalled()
    expect(() => { stop(); stop() }).not.toThrow()
  })

  it('ignores unavailable actions and recovers after one action throws', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const onError = vi.fn()
    const fidget = vi.fn()
      .mockImplementationOnce(() => { throw new Error('bad animation') })
      .mockImplementation(() => undefined)
    const stop = startAvatarBehaviorScheduler({
      profile: twoBehaviors,
      actions: { fidget },
      random: () => 0,
      now: Date.now,
      onError,
      ...injectedTimers()
    })

    vi.advanceTimersByTime(10)
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'fidget')
    vi.advanceTimersByTime(10)
    expect(fidget).toHaveBeenCalledTimes(2)
    stop()
  })
})
