// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimelineNav } from '../src/renderer/timeline-nav'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const marks = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, role: 'user' as const, text: `第 ${index} 轮` }))

describe('the rail’s ordinal ticks', () => {
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

  it('prints 10, 20, 30, 40 beside every tenth mark once the rail opens', async () => {
    await act(async () => {
      root.render(<TimelineNav marks={marks} onJump={() => {}} />)
    })
    // At rest there are no numbers — only the short handle.
    expect(host.querySelectorAll('.panel-nav-count')).toHaveLength(0)
    const nav = host.querySelector<HTMLElement>('.panel-nav')!
    await act(async () => { nav.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    const labels = [...host.querySelectorAll('.panel-nav-count')].map((node) => node.textContent)
    expect(labels).toEqual(['10', '20', '30', '40'])
  })
})
