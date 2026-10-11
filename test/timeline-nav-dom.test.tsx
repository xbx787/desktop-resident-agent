// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimelineNav, type NavMark } from '../src/renderer/timeline-nav'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

const marks = (count: number): NavMark[] =>
  Array.from({ length: count }, (_, index) => ({ id: `m${index}`, role: 'user' as const, text: `第 ${index} 条` }))

/** Mounts the rail, hovers it open (React synthesises mouse-enter from
 *  mouseover), and returns the rail plus the animate spy. */
async function mount(count: number) {
  const animate = vi.fn(() => ({ cancel: vi.fn() }) as unknown as Animation)
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<TimelineNav marks={marks(count)} onJump={() => {}} />))
  const rail = container.querySelector('.panel-nav') as HTMLElement
  await act(async () => { rail.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
  return { rail, animate }
}

/** One wheel notch; clientY sits inside row 0, so the hover card pins to the
 *  window's first mark — the observable of where the window points. */
async function wheel(rail: HTMLElement, deltaY: number) {
  await act(async () => {
    rail.dispatchEvent(new WheelEvent('wheel', { deltaY, clientY: 7, bubbles: true, cancelable: true }))
  })
}

const cardText = (): string => container?.querySelector('.panel-nav-card')?.textContent ?? ''

describe('TimelineNav wheel at the rail ends', () => {
  it('stays quiet at a hard stop, and pushes in only when the window really rolls', async () => {
    const { rail, animate } = await mount(100)
    // The hover expanded the rail to the full sixty-mark window, pointing at
    // start 40 — the newest marks, i.e. already at the bottom.
    expect(rail.querySelectorAll('.panel-nav-mark')).toHaveLength(60)

    // At the bottom: a downward nudge moves nothing and plays no push-in.
    await wheel(rail, 120)
    expect(cardText()).toContain('第 40 条')
    expect(animate).not.toHaveBeenCalled()

    // Upward now rolls: the window has somewhere to go.
    await wheel(rail, -120)
    expect(cardText()).toContain('第 37 条')
    expect(animate).toHaveBeenCalledTimes(1)

    // Thirteen more upward notches reach the oldest mark (40 → 0 in steps of 3).
    for (let i = 0; i < 13; i++) await wheel(rail, -120)
    expect(cardText()).toContain('第 0 条')
    const played = animate.mock.calls.length

    // At the top: another upward nudge stays quiet — no roll, window pinned.
    await wheel(rail, -120)
    expect(cardText()).toContain('第 0 条')
    expect(animate).toHaveBeenCalledTimes(played)
  })
})
