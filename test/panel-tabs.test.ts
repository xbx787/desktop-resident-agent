import { describe, expect, it } from 'vitest'
import { moveTab, orderConversationTabs, quickTabLimit, showNewTabButton, TAB_SLOTS } from '../src/renderer/panel-tabs'

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

describe('orderConversationTabs', () => {
  const item = (id: string, updatedAt: string) => ({ id, updatedAt })

  it('falls back to recency while no hand arrangement exists', () => {
    const items = [item('a', '2026-10-01'), item('b', '2026-10-03'), item('c', '2026-10-02')]
    expect(orderConversationTabs(items, []).map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  })

  it('leads with the arranged ids in their arranged order', () => {
    const items = [item('a', '2026-10-01'), item('b', '2026-10-03'), item('c', '2026-10-02')]
    expect(orderConversationTabs(items, ['a', 'c', 'b']).map((entry) => entry.id)).toEqual(['a', 'c', 'b'])
  })

  it('appends unplaced ids by recency after the arranged ones', () => {
    const items = [item('a', '2026-10-01'), item('b', '2026-10-03'), item('c', '2026-10-02')]
    expect(orderConversationTabs(items, ['b']).map((entry) => entry.id)).toEqual(['b', 'c', 'a'])
  })

  it('ignores arrangement ids that are not in the list', () => {
    const items = [item('a', '2026-10-01'), item('b', '2026-10-03')]
    expect(orderConversationTabs(items, ['gone', 'a']).map((entry) => entry.id)).toEqual(['a', 'b'])
  })
})

describe('moveTab', () => {
  it('moves an id to the target slot', () => {
    expect(moveTab(['a', 'b', 'c', 'd'], 'd', 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveTab(['a', 'b', 'c', 'd'], 'a', 2)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('clamps the target and returns the same array when nothing moves', () => {
    expect(moveTab(['a', 'b', 'c'], 'c', 9)).toEqual(['a', 'b', 'c'])
    expect(moveTab(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c'])
    const ids = ['a', 'b']
    expect(moveTab(ids, 'missing', 0)).toBe(ids)
    expect(moveTab(ids, 'a', 0)).toBe(ids)
  })
})
