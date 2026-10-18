import { describe, expect, it } from 'vitest'
import { clampEditorHeight, EDITOR_MAX_HEIGHT, EDITOR_ONE_LINE, editorHeightBounds } from '../src/renderer/panel'

/** The composer's height clamp. A measurement of 0 (a hidden panel, a
 *  zero-width pass) once wrote itself back as the height and left the box
 *  collapsed with the placeholder squeezed out — this floor is what keeps
 *  that from ever rendering. */

describe('clampEditorHeight', () => {
  it('never lets a bad measurement squeeze the box below one line', () => {
    expect(clampEditorHeight(0)).toBe(EDITOR_ONE_LINE)
    expect(clampEditorHeight(-5)).toBe(EDITOR_ONE_LINE)
  })

  it('passes sane heights through and caps at eight lines', () => {
    expect(clampEditorHeight(EDITOR_ONE_LINE)).toBe(EDITOR_ONE_LINE)
    expect(clampEditorHeight(88)).toBe(88)
    expect(clampEditorHeight(1000)).toBe(EDITOR_MAX_HEIGHT)
  })

  it('scales the one-line floor with the actual type size', () => {
    const large = editorHeightBounds({ lineHeight: '26px', paddingTop: '2px', paddingBottom: '2px' })
    expect(large).toEqual({ min: 30, max: 212 })
    // A zero measurement at the large scale must still leave room for the
    // placeholder's full line, not the 13px fallback.
    expect(clampEditorHeight(0, large)).toBe(30)
    expect(clampEditorHeight(400, large)).toBe(212)
  })

  it('falls back to the 13px metrics when no computed value is available', () => {
    expect(editorHeightBounds({ lineHeight: '', paddingTop: '2px', paddingBottom: '2px' }))
      .toEqual({ min: EDITOR_ONE_LINE, max: EDITOR_MAX_HEIGHT })
  })
})
