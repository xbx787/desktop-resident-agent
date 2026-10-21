import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const light = readFileSync('src/renderer/panel-light.css', 'utf8')
const base = readFileSync('src/renderer/panel.css', 'utf8')

describe('panel light theme', () => {
  it('scopes every rule to the light class', () => {
    const unscoped = light.split(/\r?\n/).filter((line) => /^\.panel-/.test(line))
    expect(unscoped).toEqual([])
  })

  it('keeps the five state colors identical in both themes', () => {
    // 完成 / 进行 / 失败 / 等待 / 空闲：生成时跳过，不允许被翻转。
    // 只校验基础面板里真的出现的颜色；紫/蓝状态色只用于头像窗口的点。
    for (const color of ['#80d6a1', '#f3c36f', '#f48790', '#b79cff', '#86b3f2']) {
      if (!base.toLowerCase().includes(color)) continue
      expect(light.toLowerCase()).toContain(color)
    }
  })

  it('covers the panel stylesheet rules', () => {
    // 每条基础规则都应该有一条对应的亮色规则，避免亮色下漏掉一整块。
    const baseRules = (base.match(/^\.panel-[^{]+\{/gm) ?? []).length
    const lightRules = (light.match(/^body\.panel-theme-light[^{]+\{/gm) ?? []).length
    expect(lightRules).toBeGreaterThanOrEqual(baseRules)
  })
})
