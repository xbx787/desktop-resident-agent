import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** One type scale across the app's three windows. UI text lives on four
 *  steps — 9 tiny, 10 secondary, 11 UI, 13 prose. Window titles sit at 16,
 *  the balance card's hero number is display type at 27, and panel.css's
 *  larger values are glyph sizes (✓ × ✎ ⚠ render as icons, not type) — they
 *  size a shape, not a paragraph. Any new in-between value (10.5px, 12px…)
 *  is how the UI drifted into eight near-identical sizes once, so it fails
 *  here and needs a deliberate decision instead of a drive-by addition. */

const UI_STEPS = ['9px', '10px', '11px', '13px']
const GLYPH_STEPS = ['14px', '16px', '17px', '19px']

const WINDOWS: Array<{ css: string; allowed: string[]; root: RegExp }> = [
  { css: 'panel.css', allowed: [...UI_STEPS, ...GLYPH_STEPS], root: /\.panel-bubble \{([^}]*)\}/ },
  { css: 'settings.css', allowed: ['10px', '11px', '13px', '16px'], root: /:root \{([^}]*)\}/ },
  { css: 'balance.css', allowed: ['10px', '11px', '13px', '16px', '27px'], root: /\.balance-peek \{([^}]*)\}/ },
  { css: 'tab-context-menu.css', allowed: ['11px'], root: /\.tab-context-menu \{([^}]*)\}/ },
  { css: 'avatar.css', allowed: ['11px'], root: /html, body, #root \{([^}]*)\}/ }
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

describe('renderer font scale', () => {
  it('keeps button font sizes !important so the inherit reset cannot shadow them', () => {
    const css = readFileSync('src/renderer/panel.css', 'utf8')
    for (const cls of BUTTON_CLASSES) {
      const block = css.match(new RegExp(`\\.${cls} \\{([^}]*)\\}`))?.[1] ?? ''
      expect(block, cls).toMatch(/font-size:\s*[\d.]+px\s*!important/)
    }
  })

  for (const { css, allowed, root } of WINDOWS) {
    it(`${css} uses only its allowed steps`, () => {
      const text = readFileSync(`src/renderer/${css}`, 'utf8')
      const used = [...new Set([...text.matchAll(/font-size:\s*([\d.]+)px/g)].map((match) => `${match[1]}px`))]
      expect(used.filter((size) => !allowed.includes(size))).toEqual([])
    })

    it(`${css} carries a baseline font size on its root so unsized text never lands on 16px`, () => {
      const text = readFileSync(`src/renderer/${css}`, 'utf8')
      expect(text.match(root)?.[1] ?? '').toMatch(/font-size:\s*11px/)
    })
  }
})
