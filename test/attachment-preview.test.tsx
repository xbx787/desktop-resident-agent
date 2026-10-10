import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AttachmentPreview, previewPlacement } from '../src/renderer/attachment-preview'

describe('previewPlacement', () => {
  it('puts the card at the chip\'s width, growing up from just above it', () => {
    const composer = { left: 100, bottom: 700 }
    const chip = { left: 130, top: 640, width: 96 }
    expect(previewPlacement(composer, chip)).toEqual({ left: 30, width: 96, bottom: 66 })
  })

  it('never lets the card hang off the composer\'s left edge', () => {
    expect(previewPlacement({ left: 100, bottom: 700 }, { left: 40, top: 640, width: 80 }).left).toBe(0)
  })
})

describe('AttachmentPreview', () => {
  it('renders the image at the measured spot with the chip\'s name on the label', () => {
    const html = renderToStaticMarkup(<AttachmentPreview placement={{ left: 30, width: 96, bottom: 66 }} name="image.png" src="data:image/png;base64,AAAA" />)
    expect(html).toContain('class="panel-attachment-preview"')
    expect(html).toContain('style="left:30px;bottom:66px;width:96px"')
    expect(html).toContain('aria-label="image.png 预览"')
    expect(html).toContain('<img src="data:image/png;base64,AAAA" alt=""/>')
  })
})
