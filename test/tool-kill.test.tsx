// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TimelineItem } from '../src/renderer/panel'
import type { TimelineEntry } from '../src/shared/contracts'

/** The kill switch on a running tool row: it must appear from the clock
 *  (the row has been running past a minute) and from nothing else — opening
 *  and shutting the row must not make it emerge. */

const display = { showTimestamps: true, avatars: { user: null, assistant: null } }
const startedAt = '2026-10-11T12:00:00.000Z'
const START = Date.parse(startedAt)

function runningTool(): TimelineEntry {
  return { id: 'tool-1', kind: 'tool', text: '执行命令', time: startedAt, tool: { toolUseId: 'toolu_1', name: 'Bash', status: 'running' } }
}

describe('the tool-kill switch', () => {
  let container: HTMLDivElement
  let root: Root
  let now: number

  beforeEach(() => {
    now = START
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
    vi.restoreAllMocks()
  })

  const mount = async (): Promise<void> => {
    await act(async () => { root.render(<TimelineItem entry={runningTool()} running display={display} />) })
  }
  const toggle = async (): Promise<void> => {
    const summary = container.querySelector('summary')!
    await act(async () => { summary.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  }
  // A real interval tick after the clock was pushed forward.
  const settle = async (): Promise<void> => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)) })
  }
  const kill = (): number => container.querySelectorAll('.panel-tool-kill').length

  it('does not appear on a fresh row, and toggling the row open and shut does not summon it', async () => {
    now = START + 30_000 // half a minute in: not overdue
    await mount()
    expect(kill()).toBe(0)
    await toggle() // open
    await toggle() // shut
    expect(kill()).toBe(0)
  })

  it('appears when the row crosses the minute, on its own clock', async () => {
    now = START + 59_000 // one second short of the mark
    await mount()
    expect(kill()).toBe(0)
    await settle()
    expect(kill()).toBe(1)
  })

  it('stays in place through opening and shutting the row once it is up', async () => {
    now = START + 70_000
    await mount()
    expect(kill()).toBe(1)
    const summary = container.querySelector('summary')
    await toggle()
    await toggle()
    expect(kill()).toBe(1)
    // The row itself was never remounted by the toggles.
    expect(container.querySelector('summary')).toBe(summary)
  })
})
