// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TimelineItem } from '../src/renderer/panel'
import type { TimelineEntry, ToolRowDetail } from '../src/shared/contracts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const command = 'Get-ChildItem -Path D:/DesktopPetProject -Recurse -File | Where-Object { $_.Length -gt 1000 }'
const chineseNote = '列出项目里大于一千字节的文件并统计数量'
const withNote: TimelineEntry = {
  id: 'tool-1',
  kind: 'tool',
  text: '执行命令',
  time: '2026-10-20T12:00:00.000Z',
  tool: { toolUseId: 'toolu_1', name: 'pwsh', status: 'done', input: JSON.stringify({ command, description: chineseNote }) }
}
const withoutNote: TimelineEntry = { ...withNote, id: 'tool-2', tool: { ...withNote.tool!, input: JSON.stringify({ command }) } }
const fileEdit: TimelineEntry = {
  id: 'tool-3',
  kind: 'tool',
  text: '编辑',
  time: '2026-10-20T12:00:00.000Z',
  tool: { toolUseId: 'toolu_3', name: 'edit', status: 'done', input: JSON.stringify({ file_path: 'D:/DesktopPetProject/src/renderer/panel.tsx' }) }
}

describe('工具行信息详细程度', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => { root.unmount() })
    container.remove()
  })

  const mount = async (entry: TimelineEntry, toolRowDetail?: ToolRowDetail, workspace?: string): Promise<void> => {
    const display = { showTimestamps: true, avatars: { user: null, assistant: null }, toolRowDetail, workspace }
    await act(async () => { root.render(<TimelineItem entry={entry} display={display} />) })
  }

  it('默认显示中文说明；没有说明时显示命令本身并截断', async () => {
    await mount(withNote)
    expect(container.querySelector('.panel-tool-argument')!.textContent).toBe(chineseNote)

    await mount(withoutNote)
    const argument = container.querySelector('.panel-tool-argument')!.textContent ?? ''
    expect(argument.endsWith('…')).toBe(true)
    expect(Array.from(argument).length).toBeLessThanOrEqual(29)
  })

  it('工作区路径缩成 ~', async () => {
    await mount(fileEdit, 'brief', 'D:/DesktopPetProject')
    expect(container.querySelector('.panel-tool-argument')!.textContent).toBe('~/src/renderer/panel.tsx')
  })

  it('仅名称档不显示附加信息', async () => {
    await mount(withNote, 'name')
    expect(container.querySelector('.panel-tool-argument')).toBeNull()
    expect(container.querySelector('code')?.textContent).toBe('执行命令')
  })

  it('简略档也显示改动的加号减号数字', async () => {
    const editEntry: TimelineEntry = {
      id: 'tool-4',
      kind: 'tool',
      text: '编辑',
      time: '2026-10-20T12:00:00.000Z',
      tool: { toolUseId: 'toolu_4', name: 'edit', status: 'done', input: JSON.stringify({ file_path: 'D:/DesktopPetProject/src/a.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }) }
    }
    await mount(editEntry, 'brief', 'D:/DesktopPetProject')
    expect(container.querySelector('.panel-tool-argument')?.textContent).toBe('~/src/a.ts')
    expect(container.querySelector('.panel-tool-diff')).toBeTruthy()
    expect(container.querySelector('.panel-tool-diff-add')?.textContent).toMatch(/^\+\d+/u)
    await mount(editEntry, 'name', 'D:/DesktopPetProject')
    expect(container.querySelector('.panel-tool-diff')).toBeNull()
  })

  it('完整档保留整段中文说明', async () => {
    await mount(withNote, 'full')
    expect(container.querySelector('.panel-tool-argument')?.textContent).toBe(chineseNote)
  })
})
