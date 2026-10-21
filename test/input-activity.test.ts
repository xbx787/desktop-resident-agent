import { describe, expect, it } from 'vitest'
import { createInputActivity, keyLabel, publicInputActivity, reduceInputActivity } from '../src/shared/input-activity'

describe('input activity', () => {
  it('labels letters, modifiers and named keys', () => {
    expect(keyLabel(0x41)).toBe('A')
    expect(keyLabel(0x11)).toBe('Ctrl')
    expect(keyLabel(0x1b)).toBe('Esc')
    expect(keyLabel(0x70)).toBe('F1')
  })

  it('tracks held keys in press order and removes them on keyup', () => {
    let state = createInputActivity()
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x11 }, 1)
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x56 }, 2)
    expect(state.keys).toEqual(['Ctrl', 'V'])
    expect(state.recent).toEqual([['Ctrl', 'V']])
    state = reduceInputActivity(state, { type: 'keyup', keycode: 0x56 }, 3)
    state = reduceInputActivity(state, { type: 'keyup', keycode: 0x11 }, 4)
    expect(state.keys).toEqual([])
  })

  it('keeps only the newest three key presses in FIFO order', () => {
    let state = createInputActivity()
    for (const code of [0x41, 0x42, 0x43, 0x44]) {
      state = reduceInputActivity(state, { type: 'keydown', keycode: code }, code)
      state = reduceInputActivity(state, { type: 'keyup', keycode: code }, code)
    }
    expect(state.recent).toEqual([['B'], ['C'], ['D']])
  })

  it('merges modifiers and the key into one queue row', () => {
    let state = createInputActivity()
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x11 }, 1)
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x43 }, 2)
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x56 }, 3)
    expect(state.recent).toEqual([['Ctrl', 'C'], ['Ctrl', 'V']])
  })

  it('marks a middle-button drag only after real movement', () => {
    let state = createInputActivity()
    state = reduceInputActivity(state, { type: 'mousedown', button: 3, x: 100, y: 100 }, 1)
    expect(state.mouse.middle).toBe(true)
    state = reduceInputActivity(state, { type: 'mousemove', x: 102, y: 101 }, 2)
    expect(state.middleDrag).toBe(false)
    state = reduceInputActivity(state, { type: 'mousemove', x: 120, y: 100 }, 3)
    expect(state.middleDrag).toBe(true)
    state = reduceInputActivity(state, { type: 'mouseup', button: 3, x: 120, y: 100 }, 4)
    expect(state.mouse.middle).toBe(false)
    expect(state.middleDrag).toBe(false)
  })

  it('maps the three mouse buttons and wheel direction', () => {
    let state = createInputActivity()
    state = reduceInputActivity(state, { type: 'mousedown', button: 1, x: 0, y: 0 }, 1)
    state = reduceInputActivity(state, { type: 'mousedown', button: 2, x: 0, y: 0 }, 2)
    state = reduceInputActivity(state, { type: 'wheel', rotation: 120 }, 3)
    expect(state.mouse.left).toBe(true)
    expect(state.mouse.right).toBe(true)
    expect(state.wheel).toBe('up')
  })

  it('hides internal press bookkeeping from the panel payload', () => {
    let state = createInputActivity()
    state = reduceInputActivity(state, { type: 'keydown', keycode: 0x41 }, 1)
    const payload = publicInputActivity(state)
    expect(payload).not.toHaveProperty('pressed')
    expect(payload).not.toHaveProperty('middleOrigin')
    expect(payload.keys).toEqual(['A'])
    expect(payload.recent).toEqual([['A']])
  })
})


