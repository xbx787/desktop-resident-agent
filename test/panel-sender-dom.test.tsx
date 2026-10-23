import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TimelineEntry } from '../src/shared/contracts'
import { EntryItem } from '../src/renderer/panel'

describe('conversation sender row', () => {
  it('turns the source prefix into a name and a first-character badge', () => {
    const entry: TimelineEntry = {
      id: '1', time: '2026-10-18T00:00:00.000Z', kind: 'user',
      text: '【来自对话「开发二」】\n全部改完，要求打包。'
    }
    const html = renderToStaticMarkup(<EntryItem entry={entry} running={false}
      display={{ showTimestamps: true, avatars: { user: null, assistant: null } }} />)
    expect(html).toContain('开发二')
    expect(html).toContain('>开<')
    expect(html).toContain('全部改完')
    expect(html).not.toContain('【来自对话')
  })

  it('honours an explicit sender field', () => {
    const entry: TimelineEntry = {
      id: '2', time: '2026-10-18T00:00:00.000Z', kind: 'user',
      text: '你好', sender: { name: '开发二', badge: '开' }
    }
    const html = renderToStaticMarkup(<EntryItem entry={entry} running={false}
      display={{ showTimestamps: true, avatars: { user: null, assistant: null } }} />)
    expect(html).toContain('开发二')
    expect(html).toContain('>开<')
  })

  it('keeps the normal user avatar for a scheduled-task label', () => {
    const entry: TimelineEntry = {
      id: '3', time: '2026-10-23T10:00:00.000Z', kind: 'user',
      text: '【定时任务】\n开始做 P2。'
    }
    const html = renderToStaticMarkup(<EntryItem entry={entry} running={false}
      display={{ showTimestamps: true, avatars: { user: 'me.png', assistant: null } }} />)
    expect(html).toContain('定时任务')
    expect(html).not.toContain('>时<')
    expect(html).not.toContain('【定时任务】')
  })
})
