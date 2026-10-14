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

  it('speaks up when the search fails and guides an empty @ query', () => {
    const failed = renderToStaticMarkup(<ComposerSuggestions kind="file" query="a" items={[]} selectedIndex={0} loading={false} failed onSelect={noop} />)
    expect(failed).toContain('查找失败')
    const untouched = renderToStaticMarkup(<ComposerSuggestions kind="file" query="" items={[]} selectedIndex={0} loading={false} onSelect={noop} />)
    expect(untouched).toContain('输入文件名查找')
    const failedWhileEmpty = renderToStaticMarkup(<ComposerSuggestions kind="file" query="" items={[]} selectedIndex={0} loading={false} failed onSelect={noop} />)
    expect(failedWhileEmpty).toContain('查找失败')
  })

  it('distinguishes an empty skill picker from a command picker', () => {
    const skill = renderToStaticMarkup(<ComposerSuggestions kind="skill" query="" items={[]} selectedIndex={0} loading={false} onSelect={noop} />)
    const command = renderToStaticMarkup(<ComposerSuggestions kind="workflow" query="" items={[]} selectedIndex={0} loading={false} onSelect={noop} />)
    expect(skill).toContain('没有可用技能')
    expect(skill).toContain('aria-label="选择技能"')
    expect(command).toContain('没有可用命令')
  })
})
