import type { AppSnapshot } from '../shared/contracts'

export type AvatarTaskLane =
  | 'idle' | 'received' | 'planning' | 'executing' | 'verifying'
  | 'compacting' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type AvatarVoiceLane = 'silent' | 'listening' | 'speaking'
export type AvatarInteractionLane = 'none' | 'panel' | 'dragging'
export type AvatarEmotionLane = 'neutral' | 'happy' | 'focused' | 'attentive' | 'surprised' | 'worried'

export interface AvatarLanes {
  task: AvatarTaskLane
  voice: AvatarVoiceLane
  interaction: AvatarInteractionLane
  emotion: AvatarEmotionLane
}

export interface AvatarLaneInput {
  snapshot?: Pick<AppSnapshot, 'taskStatus' | 'avatarState' | 'contextCompacting' | 'question' | 'plan' | 'permission'> | null
  acknowledging?: boolean
  settled?: 'done' | 'failed' | null
  dragging?: boolean
  panelOpen?: boolean
}

/**
 * Resolve independent animation lanes. A voice or pointer event no longer
 * erases the underlying task phase; renderers can blend the channels in a
 * fixed order (task → voice → interaction → emotion).
 */
export function resolveAvatarLanes(input: AvatarLaneInput): AvatarLanes {
  const snapshot = input.snapshot
  const status = snapshot?.taskStatus
  const state = snapshot?.avatarState
  const awaiting = status === 'awaiting_approval' || Boolean(snapshot?.question || snapshot?.plan || snapshot?.permission)

  const voice: AvatarVoiceLane = state === 'speaking' ? 'speaking'
    : state === 'listening' ? 'listening' : 'silent'
  const interaction: AvatarInteractionLane = input.dragging ? 'dragging'
    : input.panelOpen ? 'panel' : 'none'

  let task: AvatarTaskLane = 'idle'
  if (snapshot?.contextCompacting) task = 'compacting'
  else if (awaiting) task = 'waiting'
  // `done` and `failed` remain in a stored conversation snapshot after its
  // short outcome cue has finished. Only the renderer-owned transition token
  // is allowed to replay those cues; otherwise revisiting an old tab would
  // leave the character permanently celebrating or worrying.
  else if (input.settled === 'failed') task = 'failed'
  else if (input.settled === 'done') task = 'completed'
  else if (status === 'cancelled') task = 'cancelled'
  else if (status === 'verifying') task = 'verifying'
  else if (status === 'executing' || state === 'acting') task = 'executing'
  else if (status === 'planning' || state === 'thinking') task = 'planning'
  else if (input.acknowledging) task = 'received'

  let emotion: AvatarEmotionLane = 'neutral'
  if (task === 'failed' || task === 'cancelled') emotion = 'worried'
  else if (task === 'completed' || task === 'received' || voice === 'speaking') emotion = 'happy'
  else if (task === 'waiting') emotion = 'surprised'
  else if (voice === 'listening') emotion = 'attentive'
  else if (['planning', 'executing', 'verifying', 'compacting'].includes(task)) emotion = 'focused'

  return { task, voice, interaction, emotion }
}

export function faceForAvatarEmotion(emotion: AvatarEmotionLane): string | null {
  switch (emotion) {
    case 'happy': return 'smile'
    case 'focused': return 'focus'
    case 'attentive': return 'focus'
    case 'surprised': return 'surprise'
    case 'worried': return 'failed'
    default: return null
  }
}
