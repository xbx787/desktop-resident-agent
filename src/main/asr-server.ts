// SiliconFlow ASR 上传在主进程执行，避免 Chromium 网络栈对 MediaRecorder Blob 的 chunked upload 失败。
import { voiceLog, voiceLogError } from './voice-log'

export interface TranscribeAudioRequest {
  bytes: number[]
  mimeType: string
  apiKey: string
  model?: string
  baseUrl?: string
}

export interface TranscribeAudioResult {
  text: string
}

export async function transcribeAudio(request: TranscribeAudioRequest): Promise<TranscribeAudioResult> {
  if (!request.apiKey) throw new Error('未配置 SiliconFlow API Key。')
  if (!Array.isArray(request.bytes) || request.bytes.length === 0) throw new Error('录音为空，请再说一次。')

  const buffer = Buffer.from(request.bytes)
  voiceLog('[asr-server] transcribe', { bytes: buffer.length, mimeType: request.mimeType, model: request.model })
  const blob = new Blob([buffer], { type: request.mimeType || 'audio/webm' })
  const form = new FormData()
  form.append('file', blob, 'recording.webm')
  form.append('model', request.model ?? 'FunAudioLLM/SenseVoiceSmall')

  const baseUrl = (request.baseUrl ?? 'https://api.siliconflow.cn').replace(/\/$/, '')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 30_000)
  try {
    const response = await fetch(`${baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${request.apiKey}` },
      body: form,
      signal: controller.signal,
    })
    voiceLog('[asr-server] response', { status: response.status })
    if (!response.ok) {
      // An upstream error body can echo credentials or the spoken audio. Keep
      // both the log and renderer-facing error limited to the status code.
      voiceLogError('[asr-server] response not ok', { status: response.status })
      throw new Error(`转写失败（${response.status}）。`)
    }
    const data = (await response.json()) as { text?: string }
    voiceLog('[asr-server] response data', { textLength: data.text?.length ?? 0 })
    return { text: (data.text ?? '').trim() }
  } catch (error) {
    voiceLogError('[asr-server] transcribe error', { name: error instanceof Error ? error.name : 'UnknownError' })
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('转写超时，请稍后重试。')
    }
    if (error instanceof Error && /^转写失败（\d{3}）。$/u.test(error.message)) throw error
    throw new Error('在线转写失败，请稍后重试。')
  } finally {
    clearTimeout(timeout)
  }
}
