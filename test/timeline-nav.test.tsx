import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NAV_RESTING, NAV_STEP, NAV_WINDOW_COMPACT, NAV_WINDOW_WIDE, navBoost, navCardOffset, navMarks, navPreview, navRowAt, navTrackHeight, navWheelStep, navWindow, TimelineNav } from '../src/renderer/timeline-nav'
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
    expect(navWindow(10, 0, NAV_WINDOW_WIDE)).toEqual({ from: 0, to: 10 })
    expect(navWindow(80, 0, NAV_WINDOW_WIDE)).toEqual({ from: 0, to: 60 })
    expect(navWindow(80, 5, NAV_WINDOW_WIDE)).toEqual({ from: 5, to: 65 })
    expect(navWindow(80, 99, NAV_WINDOW_WIDE)).toEqual({ from: 20, to: 80 })
  })

  it('shows the compact twenty in the small bubble', () => {
    expect(NAV_WINDOW_COMPACT).toBe(20)
    expect(navWindow(40, 0, NAV_WINDOW_COMPACT)).toEqual({ from: 0, to: 20 })
    expect(navWindow(40, 99, NAV_WINDOW_COMPACT)).toEqual({ from: 20, to: 40 })
    expect(navWindow(12, 0, NAV_WINDOW_COMPACT)).toEqual({ from: 0, to: 12 })
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

describe('navTrackHeight', () => {
  it('keeps the 5.6 px pitch at any count — the full window is the old 345.6 px, a short rail shrinks instead of stretching', () => {
    expect(navTrackHeight(60)).toBeCloseTo(345.6, 4)
    expect(navTrackHeight(3)).toBeCloseTo(26.4, 4)
    expect(navTrackHeight(11)).toBeCloseTo(71.2, 4)
  })
})

describe('navCardOffset', () => {
  it('anchors the card to the hovered row instead of a fixed 60-row offset', () => {
    // A full window reproduces the historical placement exactly.
    expect(navCardOffset(60, 0)).toBeCloseTo(-165.2, 4)
    expect(navCardOffset(60, 59)).toBeCloseTo(165.2, 4)
    // A short rail keeps the card beside the mark: the middle row sits at the centre.
    expect(navCardOffset(11, 5)).toBeCloseTo(0, 4)
    expect(navCardOffset(11, 0)).toBeCloseTo(-28, 4)
  })
})

describe('navWheelStep', () => {
  it('scales with the wheel delta so an accelerated flick still rolls the rail', () => {
    expect(navWheelStep(3)).toBe(3) // line-mode notch
    expect(navWheelStep(120)).toBe(3) // one pixel-mode notch moves three marks, as before
    expect(navWheelStep(480)).toBe(12)
    expect(navWheelStep(2000)).toBe(24) // bounded
  })
})

describe('navRowAt', () => {
  it('maps the pointer to a row and leaves the padding and the end unclaimed', () => {
    expect(navRowAt(6 + 2 * NAV_STEP + 1, 0, 10)).toBe(2)
    expect(navRowAt(2, 0, 10)).toBe(null)
    expect(navRowAt(6 + 10 * NAV_STEP, 0, 10)).toBe(null)
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

  it('paints the user\'s marks with the brighter tone', () => {
    const html = renderToStaticMarkup(<TimelineNav marks={marks(40)} onJump={() => {}} />)
    // The CSS rule always existed; the class used to be missing from the
    // render, so the tone split never showed up in the app.
    expect((html.match(/panel-nav-mark is-user/g) ?? []).length).toBe(NAV_RESTING)
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
