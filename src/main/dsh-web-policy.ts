/** 联网搜索开关与自动压缩阈值在 DSH 内核下的落点。
 *
 *  DSH 的能力由 profile 里的插件提供，"关闭搜索"不能只靠提示词：工具还在，
 *  模型就会先试一次再被拒。这里改 `$DSH_HOME/cordis.patch.yml` 这一层用户
 *  补丁，在启动 DSH 进程前把 `tool-web` 禁用、把 `compaction-basic` 的阈值
 *  换成界面里的百分比。
 *
 *  两个托管块用注释标记，只改应用自己写的那段，用户手写的其他 patch 行原样
 *  保留。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeDshModel } from './dsh-model'

const WEB_START = '# >>> 小鲸：联网搜索（应用写入，勿手改）'
const WEB_END = '# <<< 小鲸：联网搜索（应用写入，勿手改）'
const COMPACT_START = '# >>> 小鲸：自动压缩阈值（应用写入，勿手改）'
const COMPACT_END = '# <<< 小鲸：自动压缩阈值（应用写入，勿手改）'
const GOAL_START = '# >>> 小鲸：目标工具（应用写入，勿手改）'
const GOAL_END = '# <<< 小鲸：目标工具（应用写入，勿手改）'
const ACP_MODEL_START = '# >>> 小鲸：ACP 模型（应用写入，勿手改）'
const ACP_MODEL_END = '# <<< 小鲸：ACP 模型（应用写入，勿手改）'

function stripBlock(text: string, start: string, end: string): string {
  const from = text.indexOf(start)
  if (from < 0) return text
  const to = text.indexOf(end, from)
  const tail = to < 0 ? '' : text.slice(to + end.length)
  return `${text.slice(0, from)}${tail}`
}

function rewriteFile(file: string, start: string, end: string, body: string): void {
  let existing = ''
  try {
    existing = readFileSync(file, 'utf8')
  } catch {
    existing = ''
  }
  const rest = stripBlock(existing, start, end)
    .split(/\r?\n/u)
    // 注释 + `[]` 是 DSH 生成的空 profile；`[]` 不能和后面的列表项共存，
    // 保留注释、丢掉空数组标记，否则会写出非法 YAML。
    .filter((line) => line.trim() !== '[]')
    .join('\n')
    .trim()
  const userPart = rest
  const managed = body.trim() ? `${start}\n${body.trim()}\n${end}` : ''
  const next = [userPart, managed].filter((part) => part.length > 0).join('\n\n')
  writeFileSync(file, `${next || '[]'}\n`, 'utf8')
}

function rewrite(home: string, start: string, end: string, body: string): void {
  rewriteFile(path.join(home, 'cordis.patch.yml'), start, end, body)
}

/** @param home 应用自己的 DSH_HOME（data/dsh-home）。
 *  @param enabled false 时禁用 `tool-web`，true 时移除禁用块。 */
export function syncDshWebPatch(home: string, enabled: boolean): void {
  rewrite(home, WEB_START, WEB_END, enabled ? '' : '- id: tool-web\n  disabled: true')
}

/** @param percent 自动压缩阈值（50–90），转成 DSH 的 0–1 比例。 */
export function syncDshCompactPatch(home: string, percent: number): void {
  const ratio = Math.min(0.9, Math.max(0.5, Number.isFinite(percent) ? percent / 100 : 0.8))
  rewrite(home, COMPACT_START, COMPACT_END, `- id: compaction-basic\n  config:\n    thresholdRatio: ${ratio}`)
}

/** 禁用 DSH 自带的目标工具：目标由宿主循环管理，避免模型再开一个不可见的循环。 */
export function syncDshGoalToolPatch(home: string): void {
  rewrite(home, GOAL_START, GOAL_END, '- id: tool-goal\n  disabled: true')
}

/** 把 ACP profile 的默认模型钉到适配器目录里的 id。
 *
 *  DSH 在 `initialize` 握手时就用 profile 的默认模型判断能否收图；如果这里
 *  还是 `deepseek-v4-flash`，握手会回 `promptCapabilities.image: false`，之后
 *  宿主不再发图片块，`read_image` 也会拒绝，模型便“一直认为自己没有读图能力”。
 *  只改应用自己的托管块，用户手写的其他 patch 行原样保留。
 *
 *  @param home 应用自己的 DSH_HOME（data/dsh-home）。
 *  @param provider DSH provider id，例如 deepseek-official。
 *  @param model DSH 模型 id；允许带 `[1m]` 等 Claude 侧别名，函数内会规范化。 */
export function syncDshAcpModelPatch(home: string, provider: string, model: string): void {
  const normalized = normalizeDshModel(model)
  if (!/^[a-z0-9._-]+$/iu.test(provider) || !/^[a-z0-9._-]+$/iu.test(normalized)) {
    throw new Error(`非法的 DSH 模型配置：${provider}/${model}`)
  }
  const dir = path.join(home, 'profiles', 'acp')
  // 新装的 DSH_HOME 还没生成 profile 时不要抢先造半套目录；bundle 自带的
  // 默认模型已经是 deepseek-flash。
  if (!existsSync(path.join(dir, 'package.json'))) return
  mkdirSync(dir, { recursive: true })
  rewriteFile(path.join(dir, 'cordis.patch.yml'), ACP_MODEL_START, ACP_MODEL_END,
    `- id: acp\n  config:\n    provider: ${provider}\n    model: ${normalized}`)
}

