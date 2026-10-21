// Compatibility facade. Asset paths, face availability, anchors and motion
// profiles live together in avatar-rig.ts so a persona cannot silently acquire
// another character's face or a mismatched status anchor.
import { avatarRigFor } from './avatar-rig'

export const avatarBodyUrl: string | null = avatarRigFor('xiaojing').body
export const avatarAhogeUrl: string | null = avatarRigFor('xiaojing').ahoge

/** 当前人设对应的立绘、可选呆毛层与小鲸专属表情组。 */
export function avatarArtFor(personaId?: string | null): { body: string | null; ahoge: string | null; poses: boolean } {
  const rig = avatarRigFor(personaId)
  return { body: rig.body, ahoge: rig.ahoge, poses: Object.keys(rig.faces).length > 0 }
}

/** Built-in conversation avatar for a persona; null for the default. */
export function personaAvatarUrl(personaId?: string | null): string | null {
  return avatarRigFor(personaId).avatar
}
