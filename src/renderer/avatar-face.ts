/** State faces: which expression the portrait wears while a reply is being
 *  produced and just after it lands. The runtime marks a turn's life in
 *  avatarState — 'thinking' at send, flips with 'acting' around tool calls,
 *  'success' the moment the reply is delivered — and the portrait maps that
 *  onto the two reserved expression sprites. focus and smile are kept out of
 *  the idle rotation pool (avatar-poses.ts) so their meaning stays sharp. */

/** How long the "just finished" smile lingers before the portrait relaxes. */
export const FACE_HOLD_MS = 4200

/** How long the "heard you" smile after a fresh send holds before the turn's
 *  focus takes the face back. Short on purpose: the focus that follows is the
 *  longer story. */
export const SEND_FACE_HOLD_MS = 1400

/** The face for an avatar state, or null when no face is due. */
export function stateFace(state: string | undefined): string | null {
  if (state === 'thinking' || state === 'acting') return 'focus'
  if (state === 'success') return 'smile'
  return null
}

/** The id of the newest user message in a timeline — the anchor the send
 *  smile watches: a changed id is a fresh send (typed or steered in), while a
 *  first snapshot or a different conversation only re-anchors in silence. */
export function lastUserEntryId(timeline: readonly { id: string; kind: string }[]): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].kind === 'user') return timeline[index].id
  }
  return null
}

/** How long a finished/failed dot stays on the portrait before it fades. */
export const TASK_DOT_HOLD_MS = 6000

export interface TaskDot {
  tone: 'busy' | 'waiting' | 'done' | 'failed'
  /** Busy tones breathe like the panel's running dots; settled tones sit still. */
  pulse: boolean
}

/** The little dot on the portrait's shoulder, in the panel's own task-dot
 *  palette (panel.css .panel-task-dot-*): amber while work runs, blue while a
 *  decision waits, green/red once it settled — so a folded panel never hides
 *  whether she is still busy. */
export function taskDot(state: string | undefined): TaskDot | null {
  switch (state) {
    case 'planning':
    case 'executing':
    case 'verifying':
      return { tone: 'busy', pulse: true }
    case 'awaiting_approval':
      return { tone: 'waiting', pulse: true }
    case 'done':
      return { tone: 'done', pulse: false }
    case 'failed':
      return { tone: 'failed', pulse: false }
    default:
      return null
  }
}
