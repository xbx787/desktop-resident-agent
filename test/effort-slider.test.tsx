import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { stopOffsetCss, TRACK_END_INSET } from '../src/shared/effort'
import { EffortSlider } from '../src/renderer/effort-slider'

describe('stopOffsetCss', () => {
  it('insets the outer stops by the end-cap radius and divides the rest evenly', () => {
    expect(TRACK_END_INSET).toBe(9) // half of the 18 px track height
    expect(stopOffsetCss(0, 4)).toBe('calc(9px + (100% - 18px) * 0.0000)')
    expect(stopOffsetCss(3, 4)).toBe('calc(9px + (100% - 18px) * 1.0000)')
    expect(stopOffsetCss(1, 4)).toBe(`calc(9px + (100% - 18px) * ${(1 / 3).toFixed(4)})`)
  })
})

describe('EffortSlider', () => {
  it('puts every tick and the fill on the shared stop offsets', () => {
    const html = renderToStaticMarkup(<EffortSlider value="off" onCommit={() => {}} />)
    // The end dots sit at the centre of the track's rounded caps — the exact
    // spot the thumb's centre rests on (the input is inset in CSS so the two
    // meet there); an 18 px inset regression made the thumb miss them.
    expect(html).toContain('left:calc(9px + (100% - 18px) * 0.0000)')
    expect(html).toContain('left:calc(9px + (100% - 18px) * 1.0000)')
  })

  it('fills up to the shown stop, not past it', () => {
    const html = renderToStaticMarkup(<EffortSlider value="off" onCommit={() => {}} />)
    expect(html).toContain('width:calc(9px + (100% - 18px) * 0.0000)')
  })
})
