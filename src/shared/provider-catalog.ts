/** The built-in vendor list behind the model form: pick a vendor, pick one of
 *  its standard models — no URLs or ids to type. Every vendor here speaks the
 *  Anthropic Messages protocol, which is what lets Claude Code CLI-talk to it
 *  (Kimi and Zhipu document this access mode for Claude Code directly).
 *  Model ids follow each vendor's docs as of 2026-10-10; they change over
 *  time, which is why the form always keeps a custom path available. */

export interface CatalogModel {
  id: string
  name: string
}

export interface CatalogProvider {
  id: string
  name: string
  /** Anthropic-compatible base URL; requests go to `${baseUrl}/v1/messages`. */
  baseUrl: string
  /** Default small/fast model for the Haiku slot and subagents. */
  smallModel?: string
  models: CatalogModel[]
}

export const PROVIDER_CATALOG: CatalogProvider[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    smallModel: 'deepseek-flash',
    models: [
      { id: 'deepseek-flash[1m]', name: 'DeepSeek Flash（1M 上下文）' },
      { id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner（推理）' }
    ]
  },
  {
    id: 'kimi',
    name: 'Kimi（月之暗面）',
    baseUrl: 'https://api.moonshot.cn/anthropic',
    smallModel: 'kimi-k2.5',
    models: [
      { id: 'kimi-k3', name: 'Kimi K3' },
      { id: 'kimi-k2.7-code-highspeed', name: 'Kimi K2.7 Code 高速' },
      { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code' },
      { id: 'kimi-k2.6', name: 'Kimi K2.6' },
      { id: 'kimi-k2.5', name: 'Kimi K2.5' }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    smallModel: 'glm-4.5-air',
    models: [
      { id: 'glm-4.6', name: 'GLM-4.6（旗舰）' },
      { id: 'glm-4.5', name: 'GLM-4.5' },
      { id: 'glm-4.5-air', name: 'GLM-4.5 Air（轻量）' }
    ]
  }
]
