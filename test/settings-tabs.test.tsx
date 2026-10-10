import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'

describe('SettingsPage tabs', () => {
  it('shows one group at a time behind a top tab row', () => {
    const html = renderToStaticMarkup(<SettingsPage />)
    for (const label of ['对话', '模型', '称呼', '头像']) expect(html).toContain(`>${label}</button>`)
    expect(html).toContain('role="tablist"')
    // The first group is the default; the other groups are not rendered at all.
    expect(html).toContain('id="settings-panel-conversation"')
    expect(html).not.toContain('id="settings-panel-models"')
    expect(html).not.toContain('添加模型')
  })
})
