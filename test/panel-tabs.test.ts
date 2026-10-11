import { describe, expect, it } from 'vitest'
import { quickTabLimit, showNewTabButton, TAB_SLOTS } from '../src/renderer/panel-tabs'

describe('quickTabLimit', () => {
  it('caps the strip at five slots, whatever the stored setting says', () => {
    expect(TAB_SLOTS).toBe(5)
    expect(quickTabLimit(undefined)).toBe(5)
    expect(quickTabLimit(3)).toBe(3)
    expect(quickTabLimit(8)).toBe(5)
    expect(quickTabLimit(12)).toBe(5)
    expect(quickTabLimit(0)).toBe(1)
  })
})

describe('showNewTabButton', () => {
  it('hides the "+" once the fifth slot is taken', () => {
    expect(showNewTabButton(0, 5)).toBe(true)
    expect(showNewTabButton(4, 5)).toBe(true)
    expect(showNewTabButton(5, 5)).toBe(false)
    expect(showNewTabButton(6, 5)).toBe(false)
  })
})
