import { describe, expect, it } from 'vitest'
import {
  approvalCardHeight,
  approvalCardHtml,
  approvalCardWidth,
  approvalPointerLeft,
  placeApprovalCard
} from '../src/main/approval-card'

describe('批准卡', () => {
  it('标题和待批准内容完整进入卡片，按钮在正文之后', () => {
    const html = approvalCardHtml('打包 0.0.108', '将执行 npm run pack:release\n并替换 release 目录中的安装包。')
    expect(html).toContain('打包 0.0.108')
    expect(html).toContain('将执行 npm run pack:release')
    expect(html).toContain('并替换 release 目录中的安装包。')
    expect(html).not.toContain('查看参数')
    expect(html.indexOf('class="detail"')).toBeLessThan(html.indexOf('class="actions"'))
    expect(html.indexOf('class="actions"')).toBeLessThan(html.indexOf('class="approve"'))
    // 蓝底主题，而不是旧的黑灰小窗。
    expect(html).toContain('linear-gradient(160deg,#335ba8')
    expect(html).toContain('class="reject"')
    expect(html).toContain('class="approve"')
  })

  it('转义内容，避免把标题里的标签当成 HTML', () => {
    const html = approvalCardHtml('<b>危险</b>', 'a & b')
    expect(html).toContain('&lt;b&gt;危险&lt;/b&gt;')
    expect(html).toContain('a &amp; b')
    expect(html).not.toContain('<b>危险</b>')
  })

  it('短请示用自然小宽度，长请示到上限后换行', () => {
    expect(approvalCardWidth('允许？', '继续吗')).toBe(220)
    expect(approvalCardWidth('打包', '很长的内容'.repeat(80))).toBe(360)
    expect(approvalCardWidth('打包', '中等长度的说明文字，刚好比最小宽度长一些')).toBeLessThanOrEqual(360)
    expect(approvalCardHeight('允许？', '继续吗')).toBeGreaterThanOrEqual(96)
  })

  it('锚定标签正下方：水平居中，下方放不下时翻到上方并夹在工作区内', () => {
    const anchor = { x: 500, y: 100, width: 80, height: 28 }
    const size = { width: 240, height: 140 }
    expect(placeApprovalCard(anchor, size, { x: 0, y: 0, width: 1200, height: 800 }))
      .toEqual({ x: 420, y: 134 })
    const bottom = placeApprovalCard({ ...anchor, y: 700 }, size, { x: 0, y: 0, width: 1200, height: 800 })
    expect(bottom.y).toBe(554)
    const edge = placeApprovalCard({ ...anchor, x: -60 }, size, { x: 0, y: 0, width: 1200, height: 800 })
    expect(edge.x).toBe(8)
  })

  it('指针跟着标签中心走，并被限制在卡片圆角内', () => {
    expect(approvalPointerLeft({ x: 500, y: 0, width: 80, height: 28 }, { x: 420, width: 240 })).toBe(120)
    expect(approvalPointerLeft({ x: 0, y: 0, width: 10, height: 28 }, { x: 0, width: 240 })).toBe(22)
  })
})
