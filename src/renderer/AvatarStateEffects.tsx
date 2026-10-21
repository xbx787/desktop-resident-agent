/** Small state-local cues. They sit near the face and never change layout or
 * the hit target. Reduced motion keeps a static cue so state remains legible. */
export function AvatarStateEffects() {
  return (
    <span className="avatar-state-effects" aria-hidden="true">
      <span className="avatar-listen-rings"><i /><i /></span>
      <span className="avatar-speech-bars"><i /><i /><i /></span>
      <span className="avatar-success-sparkles"><i /><i /><i /></span>
      <span className="avatar-wait-mark">?</span>
    </span>
  )
}
