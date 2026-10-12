// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TurnContextMenu } from '../src/renderer/turn-context-menu'

/** The right-click menu on a turn's avatar: one item that flips into its own
 *  confirmation — deleting removes a whole turn, so it must take two taps,
 *  and a running turn must refuse both. */

describe('the turn context menu', () => {
  let bubble: HTMLDivElement
  let host: HTMLDivElement
  let root: Root
  let onDelete: ReturnType<typeof vi.fn>
  let onClose: ReturnType<typeof vi.fn>

  beforeEach(() => {
    bubble = document.createElement('div')
    bubble.className = 'panel-bubble'
    document.body.appendChild(bubble)
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    onDelete = vi.fn()
    onClose = vi.fn()
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    bubble.remove()
  })

  const mount = async (running = false): Promise<void> => {
    await act(async () => {
      root.render(<TurnContextMenu title="测试这一轮" x={10} y={10} container={bubble} running={running} onDelete={onDelete} onClose={onClose} />)
    })
  }
  const click = async (element: Element | null): Promise<void> => {
    expect(element).toBeTruthy()
    await act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
  }
  const item = (): Element | null => bubble.querySelector('.tab-context-menu > button.is-danger')
  const confirmDelete = (): Element | null => bubble.querySelector('.turn-menu-confirm-actions button.is-danger')
  const confirmCancel = (): Element | null => bubble.querySelector('.turn-menu-confirm-actions button:not(.is-danger)')

  it('opens with a single danger item, not a delete', async () => {
    await mount()
    expect(item()?.textContent).toContain('删除这一轮')
    expect(confirmDelete()).toBeNull()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('flips into its own confirmation and only then deletes', async () => {
    await mount()
    await click(item())
    expect(bubble.querySelector('.turn-menu-confirm')?.textContent).toContain('无法恢复')
    expect(onDelete).not.toHaveBeenCalled()
    await click(confirmDelete())
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('cancel folds the confirmation back without deleting', async () => {
    await mount()
    await click(item())
    await click(confirmCancel())
    expect(onDelete).not.toHaveBeenCalled()
    expect(item()?.textContent).toContain('删除这一轮')
  })

  it('refuses both taps while the turn is still running', async () => {
    await mount(true)
    const button = item() as HTMLButtonElement | null
    expect(button?.disabled).toBe(true)
    expect(button?.getAttribute('title')).toContain('还在运行')
  })
})
