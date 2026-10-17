// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { WorkCluster } from '../src/renderer/work-cluster'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Folding a live stretch by hand: the old rule nailed the running row open
 *  against the click; the owner asked for the fold to land. */

const items: TimelineEntry[] = [
  { id: 'x1', kind: 'tool', text: 'Bash · 跑测试', time: '2026-10-09T00:00:00.000Z', tool: { toolUseId: 'x1', name: 'Bash', status: 'running' } }
]

describe('folding a work cluster by hand', () => {
  let host: HTMLDivElement
  let root: Root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
  })

  const renderEntry = () => <span />
  const mount = async (running: boolean): Promise<void> => {
    await act(async () => { root.render(<WorkCluster items={items} running={running} renderEntry={renderEntry} />) })
  }
  const details = (): HTMLDetailsElement => host.querySelector('details')!
  // The browser toggles `open` before firing the event; jsdom leaves both to us.
  const toggle = async (open: boolean): Promise<void> => {
    await act(async () => {
      details().open = open
      details().dispatchEvent(new Event('toggle'))
    })
  }

  it('opens a running stretch by default, and the click folds it', async () => {
    await mount(true)
    expect(details().open).toBe(true)
    await toggle(false)
    expect(details().open).toBe(false)
  })

  it('keeps a hand fold through a transient non-running snapshot', async () => {
    await mount(true)
    await toggle(false)
    await mount(false)
    await mount(true)
    expect(details().open).toBe(false)
  })

  it('still folds itself when the stretch ends', async () => {
    await mount(true)
    await mount(false)
    expect(details().open).toBe(false)
  })

  it('folds from the explicit 收起 row at the bottom', async () => {
    await mount(true)
    const fold = host.querySelector<HTMLButtonElement>('.panel-cluster-fold')
    expect(fold?.textContent).toContain('收起')
    await act(async () => { fold!.click() })
    expect(details().open).toBe(false)
  })
})
