import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { VoiceButton, VoiceWaveform } from '../src/renderer/voice-button'

const noop = (): void => {}

describe('VoiceButton', () => {
  it('uses one stop square while listening, without the old wave layers', () => {
    const html = renderToStaticMarkup(<VoiceButton phase="listening" canListen onToggle={noop} />)
    expect(html).toContain('panel-voice-recording')
    expect(html).toContain('<i></i>')
    expect(html).not.toContain('panel-voice-wave')
  })

  it('shows a spinner only while transcribing and the microphone at rest', () => {
    expect(renderToStaticMarkup(<VoiceButton phase="processing" canListen onToggle={noop} />)).toContain('panel-voice-spinner')
    expect(renderToStaticMarkup(<VoiceButton phase="idle" canListen onToggle={noop} />)).toContain('<svg')
  })

  it('labels the listening action as stop-and-transcribe', () => {
    const html = renderToStaticMarkup(<VoiceButton phase="listening" canListen onToggle={noop} />)
    expect(html).toContain('aria-label="停止录音并转写"')
    expect(html).toContain('aria-pressed="true"')
  })
})

describe('VoiceWaveform', () => {
  it('renders a row of spectrum bars while recording, not a text line', () => {
    const html = renderToStaticMarkup(<VoiceWaveform phase="listening" />)
    expect(html).toContain('panel-voice-waveform')
    expect(html.match(/<i /g)).toHaveLength(14)
    expect(html).not.toContain('正在听')
    expect(html).not.toContain('正在录音…')
  })

  it('shows nothing at rest and a slower processing wave while transcribing', () => {
    expect(renderToStaticMarkup(<VoiceWaveform phase="idle" />)).toBe('')
    expect(renderToStaticMarkup(<VoiceWaveform phase="processing" />)).toContain('is-processing')
  })
})
