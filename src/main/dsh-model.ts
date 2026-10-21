/** DSH 模型 id 的规范化。
 *
 *  界面上给 Claude Code 用的 `deepseek-flash[1m]` 是 1M 上下文变体，DSH 的
 *  DeepSeek 适配器目录里只有 `deepseek-flash`。旧版本把 `[1m]` 原样传给
 *  `session/set_config_option`，ACP 报 “unknown model option”，宿主又把错误
 *  吞掉，于是会话一直停在 profile 默认的 `deepseek-v4-flash`（同样不在目录，
 *  读图能力被判 false）。这里把已知别名收敛到目录 id，未知 id 原样保留，
 *  交给 ACP 的显式错误去暴露。
 */

/** 适配器目录里声明了 `inputModalities: ["text", "image"]` 的默认模型。 */
export const DEFAULT_DSH_MODEL = 'deepseek-flash'

const MODEL_ALIASES: Record<string, string> = {
  'deepseek-flash[1m]': DEFAULT_DSH_MODEL,
  'deepseek-flash-1m': DEFAULT_DSH_MODEL,
  'deepseek-v4-flash': DEFAULT_DSH_MODEL
}

/** @param model 界面/环境变量传来的模型 id，可能带 `[1m]` 后缀或旧别名。
 *  @returns DSH 适配器目录里的模型 id。 */
export function normalizeDshModel(model: string | undefined | null): string {
  const raw = (model ?? '').trim()
  if (!raw) return DEFAULT_DSH_MODEL
  const lower = raw.toLowerCase()
  const alias = MODEL_ALIASES[lower]
  if (alias) return alias
  // 只去掉 Claude Code 侧的 1M 后缀，不改动其它未知 id。
  const withoutSuffix = lower.replace(/\[1m\]$/u, '')
  return withoutSuffix || DEFAULT_DSH_MODEL
}
