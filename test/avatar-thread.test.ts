import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'panel.css'), 'utf8')

/** The raw declaration block of a selector — enough for a flat value guard.
 *  Anchored to the start of a line so a prefixed variant (e.g.
 *  `.panel-side-strip .panel-status`) cannot shadow the base rule. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp('(?:^|\\n)' + escaped + '\\s*\\{([^}]*)\\}'))
  return match ? match[1] : ''
}

describe('avatar thread geometry', () => {
  it('keeps the stats dot on the avatar column axis and paints both states', () => {
    // 轴 = 头像列的一半（33/2）；点宽 7 → 几何 left = 13，再加 0.8px 的设备
    // 像素补偿（与桥同一笔账：本机 125% 缩放下统计行光栅化偏 1 个设备像素）。
    expect(rule('.panel-event-glyph')).toContain('width: 33px')
    const glyphWidth = Number(rule('.panel-event-glyph').match(/width:\s*(\d+)px/)![1])
    const dotWidth = Number(rule('.panel-turn-stats-dot').match(/width:\s*(\d+)px/)![1])
    const dotLeft = Number(((glyphWidth - dotWidth) / 2 + 0.8).toFixed(1))
    expect(rule('.panel-turn-stats-dot')).toContain(`left: ${dotLeft}px`)
    expect(rule('.panel-turn-stats-dot.is-running')).toContain('background: #f3c36f')
    expect(rule('.panel-turn-stats-dot.is-done')).toContain('background: #9db9e9')
  })

  it('runs the thread to the block bottom and bridges the stats gap onto the dot', () => {
    const thread = rule('.panel-event-avatar::after')
    expect(thread).toContain('bottom: 0;')
    const bridge = rule('.panel-turn-stats:has(.panel-turn-stats-dot)::before')
    expect(bridge).toContain('top: -15px')
    expect(bridge).toContain('height: calc(50% + 11.5px)')
    // 桥和头像下的线必须同一条铅垂线：桥的 left = 头像宽/2（16.5）——旧公式
    // （宽/2 − 线半宽 = 15.7）+ 0.8px 设备像素补偿。实测：补偿前桥在 280.52、
    // 头像线在 281.49（同一屏），补 0.8（= 1÷1.25）后桥到 281.48。
    const glyphWidth = Number(rule('.panel-event-glyph').match(/width:\s*(\d+)px/)![1])
    const bridgeLeft = Number((glyphWidth / 2).toFixed(1))
    expect(bridge).toContain(`left: ${bridgeLeft}px`)
  })

  it('never lets the feed scroll sideways', () => {
    // 绝对定位的悬停提示与扫光条会撑 scrollWidth；横向 auto 会把它们变成
    // 窗口底部常驻的粗横条。对话流的宽内容（代码块、表格）各自内部滚动。
    const feed = rule('.panel-feed')
    expect(feed).toContain('overflow-x: hidden')
    expect(feed).toContain('overflow-y: auto')
  })

  it('keeps the status dot and the working dots on the same axis as the thread', () => {
    const axis = Number(rule('.panel-event-glyph').match(/width:\s*(\d+)px/)![1]) / 2
    // 状态点：13px 内边距后，点（宽 7）的中心落在轴线上。
    const statusDot = Number(rule('.panel-status i').match(/width:\s*(\d+)px/)![1])
    const statusPad = Number(rule('.panel-status').match(/padding-left:\s*([\d.]+)px/)![1])
    expect(statusPad + statusDot / 2).toBe(axis)
    // 工作点：首点（宽 5）的中心同样落在轴线上。
    const workDot = Number(rule('.panel-working-dots i').match(/width:\s*(\d+)px/)![1])
    const workPad = Number(rule('.panel-working').match(/padding-left:\s*([\d.]+)px/)![1])
    expect(workPad + workDot / 2).toBe(axis)
  })
})
