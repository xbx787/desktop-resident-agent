import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ComposerSuggestions } from '../src/renderer/composer-suggestions'

const item = { id: 'a', label: '文件 A', detail: 'docs/a.md', insertText: '@{docs/a.md}' }
const noop = (): void => {}

describe('ComposerSuggestions', () => {
  it('renders matches and keeps the selected row marked', () => {
    const html = renderToStaticMarkup(<ComposerSuggestions kind="file" query="a" items={[item]} selectedIndex={0} loading={false} onSelect={noop} />)
    expect(html).toContain('文件 A')
    expect(html).toContain('docs/a.md')
    expect(html).toContain('aria-selected="true"')
  })

  it('says it is looking, or that a finished search found nothing', () => {
    const loading = renderToStaticMarkup(<ComposerSuggestions kind="file" query="a" items={[]} selectedIndex={0} loading onSelect={noop} />)
    expect(loading).toContain('正在查找…')
    const empty = renderToStaticMarkup(<ComposerSuggestions kind="file" query="zzz" items={[]} selectedIndex={0} loading={false} onSelect={noop} />)
    expect(empty).toContain('没有匹配内容')
  })

  it('speaks up when the search fails, and stays quiet before the first keystroke', () => {
    const failed = renderToStaticMarkup(<ComposerSuggestions kind="file" query="a" items={[]} selectedIndex={0} loading={false} failed onSelect={noop} />)
    expect(failed).toContain('查找失败')
    const untouched = renderToStaticMarkup(<ComposerSuggestions kind="file" query="" items={[]} selectedIndex={0} loading={false} onSelect={noop} />)
    expect(untouched).toBe('')
    const failedWhileEmpty = renderToStaticMarkup(<ComposerSuggestions kind="file" query="" items={[]} selectedIndex={0} loading={false} failed onSelect={noop} />)
    expect(failedWhileEmpty).toContain('查找失败')
  })
})
