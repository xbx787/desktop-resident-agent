import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NAV_RESTING, NAV_STEP, navBoost, navMarks, navPreview, navWindow, TimelineNav } from '../src/renderer/timeline-nav'
import { groupTimeline } from '../src/renderer/timeline-groups'
import type { TimelineEntry } from '../src/shared/contracts'

const entry = (kind: TimelineEntry['kind'], text: string): TimelineEntry =>
  ({ id: `${kind}-${text}`, time: '2026-10-10T00:00:00.000Z', kind, text })

describe('navMarks', () => {
  it('keeps one mark per turn — the user line and the first reply — and drops the stream pieces between', () => {
    const groups = groupTimeline([
      entry('user', '问题'),
      entry('thinking', '想想'),
      entry('assistant', '第一句'),
      entry('tool', 'Read'),
      entry('assistant', '中间一句'),
      entry('assistant', '结尾一句'),
      entry('system', '通知')
    ])
    const marks = navMarks(groups)
    expect(marks.map((mark) => `${mark.role}:${mark.text}`)).toEqual(['user:问题', 'assistant:第一句'])
    // The text is the entry's own string, not a copy — the rail must not
    // double the memory the timeline already holds.
    expect(marks[0].text).toBe('问题')
  })
})

describe('navWindow', () => {
  it('slides a fixed-size window clamped to the ends', () => {
    expect(navWindow(10, 0)).toEqual({ from: 0, to: 10 })
    expect(navWindow(80, 0)).toEqual({ from: 0, to: 60 })
    expect(navWindow(80, 5)).toEqual({ from: 5, to: 65 })
    expect(navWindow(80, 99)).toEqual({ from: 20, to: 80 })
  })
})

describe('navPreview', () => {
  it('drops everything past three lines\' worth instead of scrolling it', () => {
    expect(navPreview('  短消息  ')).toBe('短消息')
    const long = '长'.repeat(200)
    expect(navPreview(long)).toBe(`${'长'.repeat(120)}…`)
    expect(navPreview(long).length).toBe(121)
  })
})

describe('NAV_STEP', () => {
  it('lands on a whole physical pixel row under 125% display scaling', () => {
    expect(NAV_STEP * 1.25).toBe(7)
  })
})

describe('navBoost', () => {
  it('shapes the dock arc: longest under the pointer, shrinking with distance', () => {
    expect(navBoost(0)).toBe(10)
    expect(navBoost(1)).toBe(8)
    expect(navBoost(3)).toBe(4)
    expect(navBoost(5)).toBe(0)
    expect(navBoost(9)).toBe(0)
  })
})

describe('TimelineNav', () => {
  const marks = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `m${index}`, role: 'user' as const, text: `第 ${index} 条` }))

  it('stays hidden below five messages', () => {
    expect(renderToStaticMarkup(<TimelineNav marks={marks(4)} onJump={() => {}} />)).toBe('')
  })

  it('rests as a short handle of the newest marks, with no card until hovered', () => {
    const html = renderToStaticMarkup(<TimelineNav marks={marks(40)} onJump={() => {}} />)
    // At rest only the newest few marks render; the wheel window and the card
    // belong to the expanded state.
    expect((html.match(/panel-nav-mark/g) ?? []).length).toBe(NAV_RESTING)
    expect(html).not.toContain('is-expanded')
    expect(html).not.toContain('panel-nav-card')
    expect(html).not.toContain('is-active')
  })
})
