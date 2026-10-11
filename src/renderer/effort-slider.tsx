import { useEffect, useRef, useState } from 'react'
import { EFFORT_LABELS, EFFORT_LEVELS, stopOffsetCss } from '../shared/effort'
import type { EffortLevel } from '../shared/contracts'

/**
 * Thinking-depth slider with a commit-on-release discipline: dragging only
 * moves a local draft (no request per stop along the way); the native `change`
 * event — one per release, one per keyboard step — is the single moment the
 * host hears about. The draft yields the moment the saved value catches up,
 * so a slow round trip can never yank the thumb mid-drag, and an unsaved
 * draft just dies with the menu it lives in.
 */
export function EffortSlider({ value, disabled = false, onCommit }: {
  value: EffortLevel
  disabled?: boolean
  onCommit: (level: EffortLevel) => void
}) {
  const [draft, setDraft] = useState<EffortLevel | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    const commit = (): void => commitRef.current(EFFORT_LEVELS[Number(input.value)])
    input.addEventListener('change', commit)
    return () => input.removeEventListener('change', commit)
  }, [])

  useEffect(() => {
    if (draft !== null && value === draft) setDraft(null)
  }, [value, draft])

  const shown = draft ?? value
  const index = Math.max(0, EFFORT_LEVELS.indexOf(shown))

  return <div className="panel-effort-row">
    <div className="panel-effort-slider-wrap">
      <span className="panel-effort-track" aria-hidden="true">
        <span className="panel-effort-fill" style={{ width: stopOffsetCss(index, EFFORT_LEVELS.length) }} />
        {EFFORT_LEVELS.map((level, tick) => <i key={level}
          className={`panel-effort-tick${tick <= index ? ' is-past' : ''}`}
          style={{ left: stopOffsetCss(tick, EFFORT_LEVELS.length) }} />)}
      </span>
      <input ref={inputRef} type="range" className="panel-effort-slider" min={0} max={EFFORT_LEVELS.length - 1} step={1}
        value={index} disabled={disabled}
        aria-label="思考强度" aria-valuetext={EFFORT_LABELS[shown]}
        onChange={(event) => setDraft(EFFORT_LEVELS[Number(event.target.value)])} />
    </div>
    <span className="panel-effort-value">{EFFORT_LABELS[shown]}</span>
  </div>
}
