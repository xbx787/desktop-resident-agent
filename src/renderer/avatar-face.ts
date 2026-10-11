/** State faces: which expression the portrait wears while a reply is being
 *  produced and just after it lands. The runtime marks a turn's life in
 *  avatarState — 'thinking' at send, flips with 'acting' around tool calls,
 *  'success' the moment the reply is delivered — and the portrait maps that
 *  onto the two reserved expression sprites. focus and smile are kept out of
 *  the idle rotation pool (avatar-poses.ts) so their meaning stays sharp. */

/** How long the "just finished" smile lingers before the portrait relaxes. */
export const FACE_HOLD_MS = 4200

/** The face for an avatar state, or null when no face is due. */
export function stateFace(state: string | undefined): string | null {
  if (state === 'thinking' || state === 'acting') return 'focus'
  if (state === 'success') return 'smile'
  return null
}
