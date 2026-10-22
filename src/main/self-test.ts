/** Startup health check for the pack → restart → verify loop.
 *
 *  It runs inside the freshly launched app, touches the same files the
 *  renderer loads, and leaves a machine-readable result in
 *  `data/self-test/latest.json`. Nothing here opens extra windows or changes
 *  user settings; a failed check is reported, never auto-repaired. */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { live2dModelFor, live2dModelIds } from '../renderer/live2d-model-catalog'
import { validateModelPackage } from '../../tools/live2d-motion/model-package.mjs'

export interface SelfTestCheck {
  id: string
  ok: boolean
  detail?: string
}

export interface SelfTestResult {
  version: string
  at: string
  ok: boolean
  checks: SelfTestCheck[]
}

export interface SelfTestInput {
  version: string
  dataRoot: string
  /** `<app>/out/renderer`, or the same folder inside app.asar when packaged. */
  rendererRoot: string
  windowsReady: boolean
  settingsReady: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
}

/**
 * The catalog catches models selectable by the renderer. Directory discovery
 * additionally catches a model copied into the release resource tree before
 * its catalog entry is added. Both are intentional release checks.
 */
function findBundledModelPaths(rendererRoot: string): string[] {
  const live2dRoot = path.join(rendererRoot, 'live2d')
  const modelPaths = new Set<string>()

  for (const id of live2dModelIds) {
    const definition = live2dModelFor(id)
    if (!definition) throw new Error(`模型目录缺少 ${id} 的定义`)
    const target = path.resolve(rendererRoot, definition.modelResource)
    if (!isWithin(live2dRoot, target) || !target.toLowerCase().endsWith('.model3.json')) {
      throw new Error(`模型目录中的 ${id} 路径无效：${definition.modelResource}`)
    }
    modelPaths.add(target)
  }

  const visit = (directory: string): void => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.model3.json')) modelPaths.add(target)
    }
  }
  visit(live2dRoot)

  if (modelPaths.size === 0) throw new Error('模型目录中没有 .model3.json')
  return [...modelPaths].sort((left, right) => left.localeCompare(right))
}

export function runSelfTest(input: SelfTestInput): SelfTestResult {
  const checks: SelfTestCheck[] = []
  const check = (id: string, action: () => void): void => {
    try {
      action()
      checks.push({ id, ok: true })
    } catch (error) {
      checks.push({ id, ok: false, detail: describe(error) })
    }
  }

  check('windows', () => {
    if (!input.windowsReady) throw new Error('人物窗口或面板窗口未就绪')
  })
  check('settings-store', () => {
    if (!input.settingsReady) throw new Error('设置存储未能读取')
  })
  check('renderer-html', () => {
    const html = path.join(input.rendererRoot, 'avatar.html')
    if (!existsSync(html)) throw new Error(`缺少 ${html}`)
    if (readFileSync(html).length === 0) throw new Error('avatar.html 为空')
  })
  check('live2d-model', () => {
    for (const modelPath of findBundledModelPaths(input.rendererRoot)) {
      const result = validateModelPackage(modelPath)
      if (result.errors.length > 0) {
        throw new Error(`模型包校验失败：${path.relative(input.rendererRoot, modelPath)}：${result.errors.join('；')}`)
      }
    }
  })
  check('live2d-core', () => {
    const core = path.join(input.rendererRoot, 'live2d', 'core', 'live2dcubismcore.min.js')
    if (readFileSync(core).length < 1_000) throw new Error('Cubism Core 缺失或过小')
  })

  const result: SelfTestResult = {
    version: input.version,
    at: new Date().toISOString(),
    ok: checks.every((item) => item.ok),
    checks
  }
  const output = path.join(input.dataRoot, 'self-test', 'latest.json')
  mkdirSync(path.dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify(result, null, 2), 'utf8')
  return result
}
