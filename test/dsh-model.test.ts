import { describe, expect, it } from 'vitest'
import { DEFAULT_DSH_MODEL, normalizeDshModel } from '../src/main/dsh-model'

describe('DSH 模型 id 规范化', () => {
  it('把 Claude Code 侧的 1M 变体收敛到 DSH 目录 id', () => {
    expect(normalizeDshModel('deepseek-flash[1m]')).toBe('deepseek-flash')
    expect(normalizeDshModel('DEEPSEEK-FLASH[1M]')).toBe('deepseek-flash')
    expect(normalizeDshModel('deepseek-flash-1m')).toBe('deepseek-flash')
  })

  it('把故障里的 deepseek-v4-flash 映射到目录里的 deepseek-flash', () => {
    expect(normalizeDshModel('deepseek-v4-flash')).toBe(DEFAULT_DSH_MODEL)
  })

  it('空值回退默认模型，合法的目录 id 保持不变', () => {
    expect(normalizeDshModel(undefined)).toBe('deepseek-flash')
    expect(normalizeDshModel('   ')).toBe('deepseek-flash')
    expect(normalizeDshModel('deepseek-v4-pro')).toBe('deepseek-v4-pro')
    expect(normalizeDshModel('deepseek-flash')).toBe('deepseek-flash')
  })

  it('自定义供应商的模型 id 不改大小写', () => {
    expect(normalizeDshModel('Kimi-K3')).toBe('Kimi-K3')
    expect(normalizeDshModel('GLM-4.6[1M]')).toBe('GLM-4.6')
  })
})
