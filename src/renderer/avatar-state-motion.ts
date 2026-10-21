import { avatarRigFor } from './avatar-rig'
import type { AvatarLanes } from './avatar-lanes'
import { prefersReducedMotion } from './avatar-motion'

export type AvatarEntryCue = AvatarLanes['task'] | AvatarLanes['voice'] | AvatarLanes['interaction']

export function entryCueFor(lanes: AvatarLanes): AvatarEntryCue {
  if (lanes.interaction === 'dragging') return 'dragging'
  if (lanes.voice !== 'silent') return lanes.voice
  return lanes.task
}

function px(value: number): string { return `${Number(value.toFixed(3))}px` }
function deg(value: number): string { return `${Number(value.toFixed(3))}deg` }

export function avatarEntryFrames(cue: AvatarEntryCue, energy = 1): Keyframe[] {
  const y = (value: number): string => px(value * energy)
  const r = (value: number): string => deg(value * energy)
  const neutral = 'translate3d(0, 0, 0) rotate(0deg) scale(1)'
  switch (cue) {
    case 'received':
      return [{ transform: neutral }, { offset: .48, transform: `translate3d(0, ${y(-1.8)}, 0) rotate(${r(-.2)}) scale(1.006)` }, { transform: neutral }]
    case 'planning':
      return [{ transform: neutral }, { offset: .55, transform: `translate3d(${px(-.45 * energy)}, ${y(-.7)}, 0) rotate(${r(-.28)}) scale(1.002)` }, { transform: neutral }]
    case 'executing':
      return [{ transform: neutral }, { offset: .36, transform: `translate3d(0, ${y(1)}, 0) rotate(0deg) scale(1, .994)` }, { offset: .68, transform: `translate3d(0, ${y(-1.1)}, 0) rotate(0deg) scale(1, 1.004)` }, { transform: neutral }]
    case 'verifying':
      return [{ transform: neutral }, { offset: .5, transform: `translate3d(${px(.55 * energy)}, ${y(-.45)}, 0) rotate(${r(.32)}) scale(1.001)` }, { transform: neutral }]
    case 'compacting':
      return [{ transform: neutral }, { offset: .46, transform: `translate3d(0, ${y(1.1)}, 0) rotate(0deg) scale(.996, .994)` }, { transform: neutral }]
    case 'waiting':
      return [{ transform: neutral }, { offset: .45, transform: `translate3d(${px(.4 * energy)}, ${y(-.6)}, 0) rotate(${r(.5)}) scale(1.002)` }, { transform: neutral }]
    case 'listening':
      return [{ transform: neutral }, { offset: .5, transform: `translate3d(0, ${y(-1.25)}, 0) rotate(${r(-.16)}) scale(1.004)` }, { transform: neutral }]
    case 'speaking':
      return [{ transform: neutral }, { offset: .42, transform: `translate3d(0, ${y(-.9)}, 0) rotate(${r(.12)}) scale(1.003)` }, { transform: neutral }]
    case 'completed':
      return [{ transform: neutral }, { offset: .18, transform: `translate3d(0, ${y(.7)}, 0) rotate(0deg) scale(.998)` }, { offset: .52, transform: `translate3d(0, ${y(-3.2)}, 0) rotate(${r(-.25)}) scale(1.012)` }, { offset: .76, transform: `translate3d(0, ${y(.55)}, 0) rotate(${r(.1)}) scale(.999)` }, { transform: neutral }]
    case 'failed':
      return [{ transform: neutral }, { offset: .28, transform: `translate3d(0, ${y(-.45)}, 0) rotate(${r(.15)}) scale(1.001)` }, { offset: .68, transform: `translate3d(0, ${y(1.65)}, 0) rotate(${r(-.42)}) scale(.997)` }, { transform: neutral }]
    case 'cancelled':
      return [{ transform: neutral }, { offset: .55, transform: `translate3d(0, ${y(.85)}, 0) rotate(0deg) scale(.998)` }, { transform: neutral }]
    default:
      return [{ transform: neutral }, { transform: neutral }]
  }
}

export function avatarEntryTiming(cue: AvatarEntryCue, energy = 1): KeyframeAnimationOptions {
  const base = cue === 'completed' ? 760 : cue === 'failed' ? 620 : cue === 'dragging' ? 0 : 420
  return { duration: Math.round(base / Math.max(.7, Math.min(1.2, energy))), easing: 'cubic-bezier(.22, 1, .36, 1)' }
}

const running = new WeakMap<Element, Animation>()

export function cancelAvatarStateEntry(el: Element | null): void {
  if (!el) return
  const previous = running.get(el)
  running.delete(el)
  previous?.cancel()
}

export function playAvatarStateEntry(
  el: Element | null,
  cue: AvatarEntryCue,
  personaId?: string | null,
  reduced = prefersReducedMotion()
): Animation | null {
  if (!el) return null
  cancelAvatarStateEntry(el)
  if (reduced || cue === 'idle' || cue === 'none' || cue === 'panel' || cue === 'dragging' || cue === 'silent') return null
  const target = el as Element & { animate?: HTMLElement['animate'] }
  if (typeof target.animate !== 'function') return null
  const energy = avatarRigFor(personaId).motion.energy
  const animation = target.animate(avatarEntryFrames(cue, energy), avatarEntryTiming(cue, energy))
  running.set(el, animation)
  animation.onfinish = () => { if (running.get(el) === animation) running.delete(el) }
  return animation
}
