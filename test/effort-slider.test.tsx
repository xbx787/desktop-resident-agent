// @vitest-environment jsdom
import { act } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { EffortSlider } from '../src/renderer/effort-slider'
import type { EffortLevel } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(value: EffortLevel, onCommit: (level: EffortLevel) => void, disabled = false): Promise<HTMLInputElement> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = (next: EffortLevel): Promise<void> =>
    act(async () => root!.render(<EffortSlider value={next} disabled={disabled} onCommit={onCommit} />))
  await render(value)
  ;(container as HTMLDivElement & { rerender?: (next: EffortLevel) => Promise<void> }).rerender = render
  return container.querySelector('input')!
}

function setSlider(input: HTMLInputElement, index: number): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  setter.call(input, String(index))
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('EffortSlider', () => {
  it('draws stop dots for the middle stops only, never the two ends', () => {
    const html = renderToStaticMarkup(<EffortSlider value="max" onCommit={() => {}} />)
    expect(html.match(/panel-effort-tick/g)).toHaveLength(2)
  })

  it('only commits on release: dragging moves a draft, the change event reaches the host', async () => {
    const commits: EffortLevel[] = []
    const input = await mount('max', (level) => commits.push(level))
    await act(async () => setSlider(input, 1))
    expect(commits).toEqual([])
    expect(container!.textContent).toContain('低')
    expect(input.value).toBe('1')
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })))
    expect(commits).toEqual(['low'])
  })

  it('keeps the draft while the round trip is out and lets go once the saved value catches up', async () => {
    const input = await mount('max', () => {})
    const rerender = (container as HTMLDivElement & { rerender: (next: EffortLevel) => Promise<void> }).rerender
    await act(async () => setSlider(input, 1))
    await act(async () => rerender('max'))
    expect(input.value).toBe('1')             // an external write cannot yank the thumb mid-drag
    await act(async () => rerender('low'))    // the save lands
    await act(async () => rerender('max'))    // and the draft is gone (else it would still read 低)
    expect(container!.textContent).toContain('最大')
    expect(input.value).toBe('3')
  })

  it('commits one step per keyboard change and honors disabled', async () => {
    const commits: EffortLevel[] = []
    const input = await mount('off', (level) => commits.push(level), true)
    expect(input.disabled).toBe(true)
    const live = await mount('off', (level) => commits.push(level))
    await act(async () => setSlider(live, 1))
    await act(async () => live.dispatchEvent(new Event('change', { bubbles: true })))
    expect(commits).toEqual(['low'])
  })
})
