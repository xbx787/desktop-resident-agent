/** 模型发现：向供应商的 Anthropic 兼容端点要一次 `/v1/models`。
 *
 *  Kimi/智谱等端点对这个接口的支持并不完全一致，所以失败时只返回可读提示，
 *  不阻断用户手写模型 id；成功时把 id 去重排序，交给设置里的搜索框过滤。
 */

export interface ModelDiscoveryResult {
  ok: boolean
  models: string[]
  message: string
}

function readModels(value: unknown): string[] {
  const root = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const list = Array.isArray(root.data) ? root.data
    : Array.isArray(root.models) ? root.models
      : Array.isArray(value) ? value : []
  const ids = list.flatMap((item) => {
    if (typeof item === 'string') return [item]
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {}
    const id = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : ''
    return id.trim() ? [id.trim()] : []
  })
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right))
}

export async function discoverProviderModels(
  profile: { baseUrl: string; apiKey: string },
  timeoutMs = 10_000
): Promise<ModelDiscoveryResult> {
  const base = profile.baseUrl.replace(/\/+$/u, '')
  const endpoint = `${base}/v1/models`
  try {
    const response = await fetch(endpoint, {
      headers: {
        'x-api-key': profile.apiKey,
        'authorization': `Bearer ${profile.apiKey}`,
        'anthropic-version': '2023-06-01'
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return { ok: false, models: [], message: `鉴权失败（${response.status}），请检查 API Key。` }
      }
      return { ok: false, models: [], message: `端点没有返回模型列表（${response.status}），可以直接手写模型 ID。` }
    }
    const models = readModels(await response.json().catch(() => null))
    return models.length
      ? { ok: true, models, message: `发现 ${models.length} 个模型。` }
      : { ok: false, models: [], message: '端点返回了空列表，可以直接手写模型 ID。' }
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    return {
      ok: false,
      models: [],
      message: name === 'TimeoutError' ? '拉取模型列表超时。' : `无法从 ${profile.baseUrl} 拉取模型列表。`
    }
  }
}
