import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererDir = join(__dirname, '..', 'src', 'renderer')
const read = (name: string): string => readFileSync(join(rendererDir, name), 'utf8')

const CSS_FILES = ['panel.css', 'balance.css', 'avatar.css', 'settings.css', 'tab-context-menu.css', 'onboarding.css']

/** name -> the property names declared inside that @keyframes block. */
function keyframeProperties(css: string): Map<string, string[]> {
  const frames = new Map<string, string[]>()
  const header = /@keyframes\s+([\w-]+)\s*\{/g
  let match: RegExpExecArray | null
  while ((match = header.exec(css))) {
    let depth = 1
    let index = header.lastIndex
    while (index < css.length && depth > 0) {
      if (css[index] === '{') depth += 1
      else if (css[index] === '}') depth -= 1
      index += 1
    }
    const body = css.slice(header.lastIndex, index - 1)
    const properties: string[] = []
    for (const block of body.matchAll(/\{[^{}]*\}/g)) {
      for (const decl of block[0].matchAll(/([a-z-]+)\s*:/g)) properties.push(decl[1])
    }
    frames.set(match[1], properties)
  }
  return frames
}

/** The body of the first rule that opens with exactly `<selector> {`.
 *  选择器必须独立成条：像 `.panel-thought-label.panel-live-label` 这种组合
 *  选择器里也含 `.panel-live-label`，按子串找会先命中它、读到别人的规则体。 */
function ruleBody(css: string, selector: string): string | null {
  const needle = `${selector} {`
  let start = -1
  let from = 0
  for (;;) {
    const found = css.indexOf(needle, from)
    if (found < 0) return null
    // 前一个字符属于选择器标识符时，说明这是组合选择器的一部分。
    if (found === 0 || !/[A-Za-z0-9_-]/u.test(css[found - 1])) { start = found; break }
    from = found + 1
  }
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('renderer motion budget', () => {
  it('animates only compositor properties (transform / opacity) in every @keyframes', () => {
    const offenders: string[] = []
    let count = 0
    for (const file of CSS_FILES) {
      for (const [name, properties] of keyframeProperties(read(file))) {
        count += 1
        for (const property of properties) {
          if (property !== 'transform' && property !== 'opacity') offenders.push(`${file} @keyframes ${name}: ${property}`)
        }
      }
    }
    expect(count).toBeGreaterThan(5) // the sweep still finds the frames it guards
    // Animating anything else (filter, background-position, layout) makes the
    // renderer re-rasterize the element every frame — the live-label probe
    // (scripts/live-label-probe.cjs) measured ~3x the renderer CPU and ~2x the
    // GPU for the old filter-animation shape.
    expect(offenders).toEqual([])
  })

  it('keeps the always-on surfaces free of backdrop-filter', () => {
    // A blur behind a 92-98% opaque surface re-blurs every frame for a visual
    // effect nobody can see at that opacity; the per-frame cost is real. The
    // image viewer's dimming veil keeps its small blur — there the backdrop
    // actually shows through.
    expect(ruleBody(read('panel.css'), '.panel-bubble')).not.toContain('backdrop-filter')
    expect(ruleBody(read('panel.css'), '.panel-model-menu')).not.toContain('backdrop-filter')
    expect(read('balance.css')).not.toContain('backdrop-filter')
    expect(read('tab-context-menu.css')).not.toContain('backdrop-filter')
  })

  it('sweeps the live label on transform, never on filter or background-position', () => {
    const css = read('panel.css')
    const label = ruleBody(css, '.panel-live-label') ?? ''
    expect(label).toContain('text-shadow')
    // The opacity breath was retired: the probe priced it at over half the
    // remaining GPU cost across 80 live labels (2.2% → 1.0%) while being the
    // ingredient nobody can see. The sweep bars are the whole motion now.
    expect(label).not.toContain('animation')
    expect(label).not.toContain('will-change')
    const frames = keyframeProperties(css)
    expect(frames.has('panel-live-breath')).toBe(false)
    expect(frames.get('panel-live-sweep')).toEqual(['transform', 'transform', 'transform'])
  })
})
