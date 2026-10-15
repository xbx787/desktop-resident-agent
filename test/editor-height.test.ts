import { describe, expect, it } from 'vitest'
import { clampEditorHeight, EDITOR_MAX_HEIGHT, EDITOR_ONE_LINE } from '../src/renderer/panel'

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
})
