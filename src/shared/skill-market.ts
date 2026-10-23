/** 技能市场的来源清单。
 *
 *  官方市场只有 Anthropic 的 `anthropics/skills`；社区里 Superpowers 的
 *  brainstorming / writing-plans 等技能更完整，awesome-skills 则是社区聚合。
 *  每个来源都能在设置里单独开关，搜索时只请求已启用的仓库。
 */
export interface SkillMarketSource {
  id: string
  name: string
  repo: string
  ref: string
  /** 仓库内存放技能目录的路径；每个子目录应有 SKILL.md。 */
  path: string
  license: string
  description: string
}

export const SKILL_MARKET_SOURCES: readonly SkillMarketSource[] = [
  {
    id: 'anthropic',
    name: 'Anthropic 官方',
    repo: 'anthropics/skills',
    ref: 'main',
    path: 'skills',
    license: 'Apache-2.0',
    description: 'Anthropic 官方技能目录，文档处理等基础能力。'
  },
  {
    id: 'superpowers',
    name: 'Superpowers（社区）',
    repo: 'obra/superpowers',
    ref: 'main',
    path: 'skills',
    license: 'MIT',
    description: '社区常用的完整工作流技能：brainstorming、writing-plans、TDD、调试等。'
  },
  {
    id: 'awesome',
    name: 'Awesome Skills（社区聚合）',
    repo: 'ranbot-ai/awesome-skills',
    ref: 'main',
    path: 'skills',
    license: '见各技能',
    description: '社区聚合目录，技能数量多，建议配合搜索使用。'
  }
]

export const DEFAULT_SKILL_MARKET_SOURCES: readonly string[] = ['anthropic', 'superpowers']

/** 设置里存的是来源 id 数组；缺省只开官方和 Superpowers。 */
export function enabledSkillMarketSources(value: unknown): SkillMarketSource[] {
  const ids = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [...DEFAULT_SKILL_MARKET_SOURCES]
  const enabled = new Set(ids)
  return SKILL_MARKET_SOURCES.filter((source) => enabled.has(source.id))
}

export function isSkillMarketSourceId(value: unknown): value is string {
  return typeof value === 'string' && SKILL_MARKET_SOURCES.some((source) => source.id === value)
}
