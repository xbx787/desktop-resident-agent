// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolImageOutput } from '../src/renderer/tool-images'
import type { PetAPI } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('an image tool result', () => {
  let host: HTMLDivElement
  let root: Root
  let openPath: ReturnType<typeof vi.fn>

  beforeEach(() => {
    openPath = vi.fn(async () => undefined)
    ;(window as unknown as { pet: PetAPI }).pet = { openPath } as unknown as PetAPI
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    host.remove()
    Reflect.deleteProperty(window, 'pet')
  })

  it('stays compact until asked, then hands the file to the system viewer', async () => {
    await act(async () => {
      root.render(<ToolImageOutput images={[{ name: 'photo.png', path: 'D:\\data\\tool-images\\photo.png' }]} />)
    })
    expect(host.textContent).toContain('图片结果')
    expect(host.querySelector('img')).toBeNull()
    expect(openPath).not.toHaveBeenCalled()

    const button = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === '显示原图')!
    await act(async () => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    expect(openPath).toHaveBeenCalledWith('D:\\data\\tool-images\\photo.png')
    expect(host.querySelector('img')).toBeNull()
  })
})
