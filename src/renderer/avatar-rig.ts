import { personaById } from '../shared/personas'

export type AvatarFaceId = 'focus' | 'smile' | 'surprise' | 'sleepy' | 'shy' | 'failed'

export interface PersonaMotionProfile {
  /** RGB triplet consumed by CSS as `rgb(var(--avatar-accent) / alpha)`. */
  accent: string
  /** One-shot motion multiplier. Personality changes timing and amplitude, not geometry. */
  energy: number
  /** Normalised anchor for the small status dot. */
  statusAnchor: { x: number; y: number }
  /** Normalised face centre used by state effects and future gaze/face layers. */
  faceAnchor: { x: number; y: number }
}

export interface PersonaVisualRig {
  id: string
  body: string
  ahoge: string | null
  faces: Partial<Record<AvatarFaceId, string>>
  /** A dedicated crop may replace this later; never fall back to another persona. */
  avatar: string | null
  motion: PersonaMotionProfile
}

const xiaojingBody = new URL('./assets/whale-girl-ahoge-body.png', import.meta.url).href
const rinBody = new URL('./assets/personas/whale-persona-rin-body.png', import.meta.url).href
const remBody = new URL('./assets/personas/whale-persona-rem-body.png', import.meta.url).href
const yuiBody = new URL('./assets/personas/whale-persona-yui-body.png', import.meta.url).href
const yukinoBody = new URL('./assets/personas/whale-persona-yukino-body.png', import.meta.url).href

const rigs: Record<string, PersonaVisualRig> = {
  xiaojing: {
    id: 'xiaojing', body: xiaojingBody, ahoge: null, avatar: xiaojingBody,
    faces: {
      focus: new URL('./assets/poses/focus.png', import.meta.url).href,
      smile: new URL('./assets/poses/smile.png', import.meta.url).href,
      surprise: new URL('./assets/poses/surprise.png', import.meta.url).href,
      sleepy: new URL('./assets/poses/sleepy.png', import.meta.url).href,
      shy: new URL('./assets/poses/shy.png', import.meta.url).href,
      failed: new URL('./assets/poses/failed.png', import.meta.url).href
    },
    motion: { accent: '122 190 246', energy: 1, statusAnchor: { x: .88, y: .09 }, faceAnchor: { x: .50, y: .35 } }
  },
  rin: {
    id: 'rin', body: rinBody, ahoge: null, avatar: rinBody, faces: {},
    motion: { accent: '226 104 116', energy: .92, statusAnchor: { x: .84, y: .15 }, faceAnchor: { x: .50, y: .37 } }
  },
  rem: {
    id: 'rem', body: remBody, ahoge: null, avatar: remBody, faces: {},
    motion: { accent: '116 190 242', energy: .78, statusAnchor: { x: .86, y: .10 }, faceAnchor: { x: .50, y: .34 } }
  },
  yui: {
    id: 'yui', body: yuiBody, ahoge: null, avatar: yuiBody, faces: {},
    motion: { accent: '244 190 91', energy: 1.18, statusAnchor: { x: .86, y: .08 }, faceAnchor: { x: .50, y: .34 } }
  },
  yukino: {
    id: 'yukino', body: yukinoBody, ahoge: null, avatar: yukinoBody, faces: {},
    motion: { accent: '126 159 226', energy: .68, statusAnchor: { x: .87, y: .11 }, faceAnchor: { x: .50, y: .34 } }
  }
}

/** The visual rig is the renderer's only asset/profile source of truth. */
export function avatarRigFor(personaId?: string | null): PersonaVisualRig {
  const id = personaById(personaId).id
  return rigs[id] ?? rigs.xiaojing
}

export function avatarFaceUrl(personaId: string | null | undefined, face: string | null): string | null {
  if (!face) return null
  return avatarRigFor(personaId).faces[face as AvatarFaceId] ?? null
}

export function allAvatarRigs(): readonly PersonaVisualRig[] {
  return Object.values(rigs)
}
