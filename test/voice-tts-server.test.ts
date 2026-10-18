import { afterEach, describe, expect, it, vi } from 'vitest'
import { synthesizeSpeech } from '../src/main/voice-tts-server'

const base = {
  text: '你好，小鲸。',
  apiKey: 'secret-key',
  voice: 'FunAudioLLM/CosyVoice2-0.5B:claire',
  speed: 1
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('SiliconFlow TTS client', () => {
  it('posts the expected request and returns audio bytes', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.alloc(256, 1), {
      status: 200, headers: { 'content-type': 'audio/mpeg' }
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await synthesizeSpeech(base)
    expect(result.bytes.length).toBe(256)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.siliconflow.cn/v1/audio/speech')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer secret-key' })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({
      model: 'FunAudioLLM/CosyVoice2-0.5B',
      input: base.text,
      voice: base.voice,
      response_format: 'mp3',
      speed: 1
    })
  })

  it('maps auth and rate-limit failures without leaking the body or key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret-key echoed', { status: 401 })))
    await expect(synthesizeSpeech(base)).rejects.toThrow('API Key 无效')

    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))
    await expect(synthesizeSpeech(base)).rejects.toThrow('过于频繁')
  })

  it('rejects a JSON or empty body pretending to be audio', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', {
      status: 200, headers: { 'content-type': 'application/json' }
    })))
    await expect(synthesizeSpeech(base)).rejects.toThrow('返回异常')
  })

  it('requires a key before any request', async () => {
    await expect(synthesizeSpeech({ ...base, apiKey: '' })).rejects.toThrow('未配置')
  })
})
