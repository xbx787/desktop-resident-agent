// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ComposerSuggestions, type ComposerSuggestion } from '../src/renderer/composer-suggestions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const items: ComposerSuggestion[] = Array.from({ length: 4 }, (_, index) => ({
  id: `item-${index}`,
  label: `命令 ${index}`,
  detail: `说明 ${index}`,
  insertText: `/cmd-${index}`
}))

let container: HTMLDivElement | undefined
let root: Root | undefined

afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  container?.remove()
  root = undefined
  container = undefined
})

async function mount(selectedIndex: number) {
  const scrollIntoView = vi.fn()
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scrollIntoView })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const render = (index: number) => <ComposerSuggestions kind="workflow" query="cmd" items={items} selectedIndex={index} loading={false} onSelect={() => {}} />
  await act(async () => root!.render(render(selectedIndex)))
  return scrollIntoView
}

/** The element the browser was told to scroll to. */
function scrolledElement(scrollIntoView: ReturnType<typeof vi.fn>): HTMLElement | undefined {
  return scrollIntoView.mock.instances.at(-1) as HTMLElement | undefined
}

describe('ComposerSuggestions follow-scroll', () => {
  it('keeps the highlighted row in view when the selection moves', async () => {
    const scrollIntoView = await mount(0)
    scrollIntoView.mockClear()
    await act(async () => root!.render(<ComposerSuggestions kind="workflow" query="cmd" items={items} selectedIndex={2} loading={false} onSelect={() => {}} />))
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrolledElement(scrollIntoView)?.textContent).toContain('命令 2')
  })

  it('follows the wrap-around jump from the first row up to the last one', async () => {
    const scrollIntoView = await mount(0)
    scrollIntoView.mockClear()
    await act(async () => root!.render(<ComposerSuggestions kind="workflow" query="cmd" items={items} selectedIndex={items.length - 1} loading={false} onSelect={() => {}} />))
    expect(scrolledElement(scrollIntoView)?.textContent).toContain(`命令 ${items.length - 1}`)
  })
})
