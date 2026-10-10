import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ToolDiffBody } from '../src/renderer/tool-diff-body'
import { toolDiffPreview } from '../src/renderer/tool-diff'

const previewOf = (name: string, input: string, limit?: number) => {
  const preview = toolDiffPreview(name, input, limit)
  if (!preview) throw new Error('expected a diff preview')
  return preview
}

describe('ToolDiffBody', () => {
  it('marks added lines for green and removed lines for red', () => {
    const preview = previewOf('Edit', JSON.stringify({ old_string: 'const a = 1\nconst b = 2', new_string: 'const a = 1\nconst b = 3' }))
    const html = renderToStaticMarkup(<ToolDiffBody preview={preview} />)
    expect(html).toContain('class="panel-tool-diff-line is-context"> const a = 1</span>')
    expect(html).toContain('class="panel-tool-diff-line is-del">-const b = 2</span>')
    expect(html).toContain('class="panel-tool-diff-line is-add">+const b = 3</span>')
    expect(html).toContain('aria-label="改动，新增 1 行，删除 1 行"')
  })

  it('separates the edits of one MultiEdit call', () => {
    const preview = previewOf('MultiEdit', JSON.stringify({ edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] }))
    const html = renderToStaticMarkup(<ToolDiffBody preview={preview} />)
    expect(html.match(/is-gap/g)).toHaveLength(1)
  })

  it('says how many lines a cut-short body is not showing', () => {
    const content = Array.from({ length: 5 }, (_, index) => `line ${index}`).join('\n')
    const html = renderToStaticMarkup(<ToolDiffBody preview={previewOf('Write', JSON.stringify({ content }), 2)} />)
    expect(html).toContain('… 其余 3 行未显示')
    expect(html.match(/is-add/g)).toHaveLength(2)
  })

  it('renders a blank line as its marker alone, so the row still has height', () => {
    const preview = previewOf('Edit', JSON.stringify({ old_string: 'a\n\nb', new_string: 'a\nx\nb' }))
    const html = renderToStaticMarkup(<ToolDiffBody preview={preview} />)
    expect(html).toContain('class="panel-tool-diff-line is-del">-</span>')
    expect(html).toContain('class="panel-tool-diff-line is-add">+x</span>')
  })
})
