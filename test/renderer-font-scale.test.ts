import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 全软件只有一套字体系统：design-tokens.css。
 *
 *  六个 window 的 CSS 都必须从 --text-* / --glyph-* / --font-* 取字号和字族，
 *  不允许再出现 "font-size: 12px" 这样的局部决定。字体档位因此只有一个
 *  开关（--font-base）：设置里的「小 / 中 / 大」改它一个变量，所有窗口一起变。
 *
 *  em 例外是相对字号（Markdown 标题、行内代码），它本来就跟当前文字走。
 *  字形图标（✓ × ✎ ⚠）用 --glyph-*，那是图形尺寸，不是正文档位。 */

const CSS_FILES = [
  'panel.css', 'settings.css', 'balance.css', 'onboarding.css',
  'avatar.css', 'tab-context-menu.css'
]
const TOKEN_FILE = 'design-tokens.css'

/** 每个窗口的根元素都要落一条基线，免得没写字号的地方掉回浏览器 16px。 */
const ROOTS: Array<{ css: string; root: RegExp }> = [
  { css: 'panel.css', root: /\.panel-bubble \{([^}]*)\}/ },
  { css: 'settings.css', root: /:root \{([^}]*)\}/ },
  { css: 'balance.css', root: /\.balance-peek \{([^}]*)\}/ },
  { css: 'tab-context-menu.css', root: /\.tab-context-menu \{([^}]*)\}/ },
  { css: 'avatar.css', root: /html, body, #root \{([^}]*)\}/ },
  { css: 'onboarding.css', root: /\.onboarding-window \{([^}]*)\}/ }
]

/** Buttons whose size a plain class declaration cannot win: `.panel-bubble
 *  button { font: inherit }` (0,1,1) is more specific than any single-class
 *  rule (0,1,0), so these must keep !important — seven of them silently
 *  rendered 16px for months without it. scripts/font-cascade-probe.cjs
 *  re-checks this against the real cascade when run under Electron. */
const BUTTON_CLASSES = [
  'panel-ask-tab', 'panel-ask-option', 'panel-ask-skip', 'panel-ask-submit',
  'panel-plan-revise', 'panel-plan-approve', 'panel-quote-button', 'panel-tasks-summary',
  'panel-compact-button'
]

const SIZE_TOKEN = /^var\(--(?:text|glyph)-[a-z0-9-]+\)$/
const FAMILY_TOKEN = /^var\(--font-[a-z-]+\)$/
const FONT_SHORTHAND = /^var\(--(?:text|glyph)-[a-z0-9-]+\)\/[\d.]+ var\(--font-[a-z-]+\)$/
const RELATIVE_SIZE = /^[\d.]+em$/

describe('renderer font system', () => {
  it('defines one scale and the three UI-size stops in design-tokens.css', () => {
    const tokens = readFileSync(`src/renderer/${TOKEN_FILE}`, 'utf8')
    expect(tokens).toMatch(/--font-base:\s*11px/)
    for (const token of [
      '--text-2xs', '--text-xs', '--text-sm', '--text-md', '--text-lg', '--text-xl',
      '--glyph-sm', '--glyph-md', '--glyph-lg',
      '--font-ui', '--font-mono', '--font-numeric'
    ]) expect(tokens, token).toContain(`${token}:`)
    expect(tokens).toContain('html[data-ui-size="medium"]')
    expect(tokens).toContain('html[data-ui-size="large"]')
  })

  it('keeps every font size and family on a token outside the token file', () => {
    const violations: string[] = []
    for (const css of CSS_FILES) {
      const text = readFileSync(`src/renderer/${css}`, 'utf8')
      for (const match of text.matchAll(/font-size:\s*([^;}]+)/g)) {
        const value = match[1].trim().replace(/\s*!important$/, '')
        if (!SIZE_TOKEN.test(value) && !RELATIVE_SIZE.test(value) && value !== 'inherit') violations.push(`${css}: font-size: ${value}`)
      }
      for (const match of text.matchAll(/font-family:\s*([^;}]+)/g)) {
        const value = match[1].trim()
        if (!FAMILY_TOKEN.test(value) && value !== 'inherit') violations.push(`${css}: font-family: ${value}`)
      }
      for (const match of text.matchAll(/(?:^|[;{\s])font:\s*([^;}]+)/g)) {
        const value = match[1].trim()
        if (value !== 'inherit' && !FONT_SHORTHAND.test(value)) violations.push(`${css}: font: ${value}`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps button font sizes !important so the inherit reset cannot shadow them', () => {
    const css = readFileSync('src/renderer/panel.css', 'utf8')
    for (const cls of BUTTON_CLASSES) {
      const block = css.match(new RegExp(`\\.${cls} \\{([^}]*)\\}`))?.[1] ?? ''
      expect(block, cls).toMatch(/font-size:\s*var\(--(?:text|glyph)-[a-z0-9-]+\)\s*!important/)
    }
  })

  for (const { css, root } of ROOTS) {
    it(`${css} carries a token baseline so unsized text never lands on 16px`, () => {
      const text = readFileSync(`src/renderer/${css}`, 'utf8')
      expect(text.match(root)?.[1] ?? '').toMatch(/font-size:\s*var\(--text-sm\)/)
    })
  }
})
