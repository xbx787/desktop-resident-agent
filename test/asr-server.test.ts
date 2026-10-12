import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeAudio } from '../src/main/asr-server'
import { voiceLog, voiceLogError } from '../src/main/voice-log'

vi.mock('../src/main/voice-log', () => ({ voiceLog: vi.fn(), voiceLogError: vi.fn() }))

const request = { bytes: [1, 2, 3], mimeType: 'audio/webm', apiKey: 'private-voice-key' }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('main-process ASR privacy', () => {
  it('does not reveal an upstream error body that echoes the credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bearer private-voice-key', { status: 400 })))
    await expect(transcribeAudio(request)).rejects.toThrow('转写失败（400）。')
    expect(JSON.stringify(vi.mocked(voiceLogError).mock.calls)).not.toContain(request.apiKey)
  })

  it('returns a transcript without writing its text to diagnostic logs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ text: 'private spoken content' })))
    expect(await transcribeAudio(request)).toEqual({ text: 'private spoken content' })
    expect(JSON.stringify(vi.mocked(voiceLog).mock.calls)).not.toContain('private spoken content')
  })

  it('keeps fetch failures from forwarding credential-bearing error messages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Bearer private-voice-key') }))
    await expect(transcribeAudio(request)).rejects.toThrow('在线转写失败，请稍后重试。')
    expect(JSON.stringify(vi.mocked(voiceLogError).mock.calls)).not.toContain(request.apiKey)
  })
})
