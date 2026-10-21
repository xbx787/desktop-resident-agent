/** Startup health check for the pack → restart → verify loop.
 *
 *  It runs inside the freshly launched app, touches the same files the
 *  renderer loads, and leaves a machine-readable result in
 *  `data/self-test/latest.json`. Nothing here opens extra windows or changes
 *  user settings; a failed check is reported, never auto-repaired. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

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

interface ModelManifest {
  FileReferences?: {
    Moc?: string
    Physics?: string
    DisplayInfo?: string
    Textures?: string[]
    Motions?: Record<string, Array<{ File?: string }>>
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    const modelPath = path.join(input.rendererRoot, 'live2d', 'arch-chan', 'arch chan model0.model3.json')
    const model = JSON.parse(readFileSync(modelPath, 'utf8')) as ModelManifest
    const refs = model.FileReferences
    if (!refs) throw new Error('model3 缺少 FileReferences')
    const files = [
      refs.Moc,
      refs.Physics,
      refs.DisplayInfo,
      ...(refs.Textures ?? []),
      ...Object.values(refs.Motions ?? {}).flatMap((group) => group.map((motion) => motion.File))
    ].filter((file): file is string => typeof file === 'string' && file.length > 0)
    if (files.length === 0) throw new Error('model3 没有引用任何文件')
    const base = path.dirname(modelPath)
    for (const file of files) {
      const target = path.join(base, file)
      if (!existsSync(target)) throw new Error(`模型引用缺失：${file}`)
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
