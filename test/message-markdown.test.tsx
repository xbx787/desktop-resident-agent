import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MessageMarkdown } from '../src/renderer/message-markdown'

describe('MessageMarkdown breaks', () => {
  it('keeps single newlines as hard breaks when asked — the user typed them', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'第一行\n第二行'} breaks />)
    expect(html).toContain('<br')
  })

  it('keeps plain soft wrapping for the model’s own words', () => {
    const html = renderToStaticMarkup(<MessageMarkdown text={'第一行\n第二行'} />)
    expect(html).not.toContain('<br')
  })
})
