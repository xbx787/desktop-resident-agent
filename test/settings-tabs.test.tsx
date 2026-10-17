import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SettingsPage } from '../src/renderer/settings'

describe('SettingsPage tabs', () => {
  it('shows one group at a time behind a top tab row', () => {
    const html = renderToStaticMarkup(<SettingsPage />)
    for (const label of ['对话', '外观', '模型', '记忆', '称呼', '人设']) expect(html).toContain(`>${label}</button>`)
    expect(html).not.toContain('>成长</button>')
    expect(html).toContain('role="tablist"')
    // The first group is the default; the other groups are not rendered at all.
    expect(html).toContain('id="settings-panel-conversation"')
    expect(html).not.toContain('id="settings-panel-models"')
    expect(html).not.toContain('添加模型')
  })
})
