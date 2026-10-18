import { TTS_MODEL } from '../shared/voice'
import { voiceLog, voiceLogError } from './voice-log'

export interface SynthesizeSpeechInput {
  text: string
  apiKey: string
  baseUrl?: string
  model?: string
  voice: string
  speed: number
  signal?: AbortSignal
  timeoutMs?: number
}

export interface SynthesizeSpeechResult {
  bytes: Buffer
  mimeType: 'audio/mpeg'
}

function statusError(status: number): Error {
  if (status === 401) return new Error('SiliconFlow API Key 无效或已过期。')
  if (status === 403) return new Error('SiliconFlow 拒绝了该请求。')
  if (status === 429) return new Error('语音合成请求过于频繁，请稍后再试。')
  if (status >= 500) return new Error('SiliconFlow 语音服务暂时不可用。')
  return new Error(`语音合成失败（${status}）。`)
}

/** The single place that knows the SiliconFlow TTS request shape. Errors never
 *  carry the key, the text, or the upstream body. */
export async function synthesizeSpeech(input: SynthesizeSpeechInput): Promise<SynthesizeSpeechResult> {
  if (!input.apiKey) throw new Error('未配置 SiliconFlow API Key。')
  const text = input.text.trim()
  if (!text) throw new Error('没有可朗读的文字。')

  const baseUrl = (input.baseUrl || 'https://api.siliconflow.cn').replace(/\/+$/u, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs ?? 45_000)
  const forwardAbort = (): void => controller.abort()
  input.signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    const response = await fetch(`${baseUrl}/v1/audio/speech`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: input.model || TTS_MODEL,
        input: text,
        voice: input.voice,
        response_format: 'mp3',
        speed: input.speed
      }),
      signal: controller.signal
    })
    voiceLog('[tts-server] response', { status: response.status, bytes: Number(response.headers.get('content-length') ?? 0) })
    if (!response.ok) {
      voiceLogError('[tts-server] response not ok', { status: response.status })
      throw statusError(response.status)
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length || bytes.length < 128 ||
        contentType.includes('application/json') || contentType.startsWith('text/')) {
      throw new Error('语音合成返回异常。')
    }
    return { bytes, mimeType: 'audio/mpeg' }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      if (input.signal?.aborted) throw new Error('语音合成已取消。')
      throw new Error('语音合成超时，请稍后再试。')
    }
    if (error instanceof Error && /^(SiliconFlow|语音合成)/u.test(error.message)) throw error
    voiceLogError('[tts-server] synthesize error', { name: error instanceof Error ? error.name : 'UnknownError' })
    throw new Error('语音服务连接失败，请检查网络。')
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener('abort', forwardAbort)
  }
}

export async function probeSpeechSynthesis(input: {
  apiKey: string
  baseUrl?: string
  voice: string
  speed: number
  signal?: AbortSignal
}): Promise<void> {
  await synthesizeSpeech({
    text: '你好，我是小鲸。',
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    voice: input.voice,
    speed: input.speed,
    signal: input.signal,
    timeoutMs: 30_000
  })
}
