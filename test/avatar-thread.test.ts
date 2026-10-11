import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'panel.css'), 'utf8')

/** The raw declaration block of a selector — enough for a flat value guard. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  return match ? match[1] : ''
}

describe('avatar thread geometry', () => {
  it('keeps the stats dot on the avatar column axis and paints both states', () => {
    expect(rule('.panel-turn-stats-dot')).toContain('left: 16px')
    expect(rule('.panel-turn-stats-dot.is-running')).toContain('background: #f3c36f')
    expect(rule('.panel-turn-stats-dot.is-done')).toContain('background: #9db9e9')
  })

  it('runs the thread to the block bottom and bridges the stats gap onto the dot', () => {
    const thread = rule('.panel-event-avatar::after')
    expect(thread).toContain('bottom: 0;')
    const bridge = rule('.panel-turn-stats:has(.panel-turn-stats-dot)::before')
    expect(bridge).toContain('top: -15px')
    expect(bridge).toContain('height: calc(50% + 11.5px)')
  })
})
