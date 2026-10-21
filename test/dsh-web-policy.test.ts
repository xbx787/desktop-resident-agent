import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { syncDshAcpModelPatch, syncDshCompactPatch, syncDshGoalToolPatch, syncDshWebPatch } from '../src/main/dsh-web-policy'

const root = path.join(process.cwd(), '.cache', 'tests', `dsh-web-policy-${randomUUID()}`)
const patchFile = path.join(root, 'cordis.patch.yml')

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 60 })
})

describe('DSH ACP 模型托管块', () => {
  it('把 profile 默认模型钉到目录 id，重复写入不叠加，并保留用户自己的 patch', async () => {
    const profile = path.join(root, 'profiles', 'acp')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'package.json'), '{}\n', 'utf8')
    await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '- id: user-row\n  disabled: true\n', 'utf8')

    syncDshAcpModelPatch(root, 'deepseek-official', 'deepseek-flash')
    syncDshAcpModelPatch(root, 'deepseek-official', 'deepseek-flash')

    const text = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('- id: user-row')
    expect(text.match(/- id: acp/gu)).toHaveLength(1)
    expect(text).toContain('provider: deepseek-official')
    expect(text).toContain('model: deepseek-flash')
    expect(text).not.toContain('deepseek-v4-flash')
  })

  it('注释加空数组的 profile 追加托管块后不会留下孤立的 []', async () => {
    const profile = path.join(root, 'profiles', 'acp')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'package.json'), '{}\n', 'utf8')
    await fs.writeFile(path.join(profile, 'cordis.patch.yml'),
      '# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries.\n[]\n', 'utf8')

    syncDshAcpModelPatch(root, 'deepseek-official', 'deepseek-flash')

    const text = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('# Your patch layer for this dsh profile')
    const meaningful = text.split(/\r?\n/u).map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'))
    expect(meaningful).not.toContain('[]')
    expect(meaningful[0]).toBe('- id: acp')
  })

  it('写入函数自身也能把 [1m] 别名规范化，不再抛非法配置', async () => {
    const profile = path.join(root, 'profiles', 'acp')
    await fs.mkdir(profile, { recursive: true })
    await fs.writeFile(path.join(profile, 'package.json'), '{}\n', 'utf8')
    await fs.writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n', 'utf8')

    expect(() => syncDshAcpModelPatch(root, 'deepseek-official', 'deepseek-flash[1m]')).not.toThrow()

    const text = await fs.readFile(path.join(profile, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('model: deepseek-flash')
    expect(text).not.toContain('[1m]')
  })

  it('profile 还没生成时不去造半套目录', async () => {
    await fs.mkdir(root, { recursive: true })
    syncDshAcpModelPatch(root, 'deepseek-official', 'deepseek-flash')
    await expect(fs.readFile(path.join(root, 'profiles', 'acp', 'cordis.patch.yml'), 'utf8'))
      .rejects.toThrow()
  })

  it('拒绝可能破坏 YAML 的非法 id', () => {
    expect(() => syncDshAcpModelPatch(root, 'deepseek-official', 'bad model: x')).toThrow('非法的 DSH 模型配置')
  })
})

describe('DSH 联网搜索开关', () => {
  it('关闭时禁用 tool-web，重新打开时只留下空数组', async () => {
    await fs.mkdir(root, { recursive: true })
    syncDshWebPatch(root, false)
    const disabled = await fs.readFile(patchFile, 'utf8')
    expect(disabled).toContain('- id: tool-web')
    expect(disabled).toContain('disabled: true')

    syncDshWebPatch(root, true)
    expect((await fs.readFile(patchFile, 'utf8')).trim()).toBe('[]')
  })

  it('保留用户自己写的 patch 行，并且重复开关不叠加', async () => {
    await fs.mkdir(root, { recursive: true })
    await fs.writeFile(patchFile, '- id: user-row\n  disabled: true\n', 'utf8')

    syncDshWebPatch(root, false)
    syncDshWebPatch(root, false)
    const disabled = await fs.readFile(patchFile, 'utf8')
    expect(disabled).toContain('- id: user-row')
    expect(disabled.match(/- id: tool-web/gu)).toHaveLength(1)

    syncDshWebPatch(root, true)
    const enabled = await fs.readFile(patchFile, 'utf8')
    expect(enabled).toContain('- id: user-row')
    expect(enabled).not.toContain('tool-web')
  })

  it('把自动压缩阈值写成 compaction-basic，并和联网块共存', async () => {
    await fs.mkdir(root, { recursive: true })
    syncDshWebPatch(root, false)
    syncDshCompactPatch(root, 65)
    const text = await fs.readFile(patchFile, 'utf8')
    expect(text).toContain('- id: tool-web')
    expect(text).toContain('thresholdRatio: 0.65')

    syncDshCompactPatch(root, 90)
    const updated = await fs.readFile(patchFile, 'utf8')
    expect(updated).toContain('thresholdRatio: 0.9')
    expect(updated).toContain('- id: tool-web')
    expect(updated.match(/- id: compaction-basic/gu)).toHaveLength(1)
  })

  it('禁用 DSH 自带的目标工具，并且和联网/压缩块共存', async () => {
    await fs.mkdir(root, { recursive: true })
    syncDshWebPatch(root, false)
    syncDshCompactPatch(root, 70)
    syncDshGoalToolPatch(root)
    syncDshGoalToolPatch(root)
    const text = await fs.readFile(patchFile, 'utf8')
    expect(text).toContain('- id: tool-goal')
    expect(text.match(/- id: tool-goal/gu)).toHaveLength(1)
    expect(text).toContain('- id: tool-web')
    expect(text).toContain('thresholdRatio: 0.7')
  })
})
