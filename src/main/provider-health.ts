/** 供应商地址健康检查。
 *
 *  用户经常把 baseUrl 指向本机代理（127.0.0.1:端口）。代理没启动时请求会
 *  直接 ConnectionRefused，界面却只显示“网络错误”，很难判断是代理死了还是
 *  Key 错了。这里在启动和切换模型时先做一次轻量 TCP 探测，给出明确指向，
 *  并告诉调用方官方 Anthropic 兼容地址，便于一键切回。
 */
import { connect } from 'node:net'

export const OFFICIAL_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic'

export type ProviderIssueKind = 'connection-refused' | 'timeout' | 'dns' | 'unreachable' | 'invalid-url' | 'ok'

export interface ProviderIssue {
  baseUrl: string
  kind: ProviderIssueKind
  localProxy: boolean
  message: string
  officialUrl: string
}

export interface ProviderHealth extends ProviderIssue {
  ok: boolean
}

function localHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '')
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0'
}

function failure(baseUrl: string, kind: ProviderIssueKind, detail: string, localProxy: boolean): ProviderHealth {
  const where = localProxy ? '本地代理' : '供应商地址'
  return {
    ok: false,
    baseUrl,
    kind,
    localProxy,
    officialUrl: OFFICIAL_ANTHROPIC_BASE_URL,
    message: kind === 'connection-refused'
      ? `${where}拒绝连接：${detail} 没有在运行。请启动代理后重试，或一键切到官方地址 ${OFFICIAL_ANTHROPIC_BASE_URL}。`
      : `${where}无法连接：${detail}。请检查网络或代理，或一键切到官方地址 ${OFFICIAL_ANTHROPIC_BASE_URL}。`
  }
}

/** 只建立 TCP 连接，不发请求、不校验 Key：地址活着就算健康。 */
export async function probeProviderHealth(baseUrl: string, timeoutMs = 2_500): Promise<ProviderHealth> {
  let url: URL
  try {
    url = new URL(baseUrl)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol')
  } catch {
    return failure(baseUrl, 'invalid-url', baseUrl || '（空地址）', false)
  }
  const proxy = localHost(url.hostname)
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  const detail = `${url.hostname}:${port}`
  return await new Promise<ProviderHealth>((resolve) => {
    let settled = false
    const finish = (result: ProviderHealth): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ''), port })
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => {
      finish({
        ok: true,
        baseUrl,
        kind: 'ok',
        localProxy: proxy,
        officialUrl: OFFICIAL_ANTHROPIC_BASE_URL,
        message: '地址可连接。'
      })
    })
    socket.once('timeout', () => finish(failure(baseUrl, 'timeout', detail, proxy)))
    socket.once('error', (error: NodeJS.ErrnoException) => {
      const code = (error.code ?? '').toUpperCase()
      const kind: ProviderIssueKind = code === 'ECONNREFUSED'
        ? 'connection-refused'
        : code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'dns' : 'unreachable'
      finish(failure(baseUrl, kind, detail, proxy))
    })
  })
}
