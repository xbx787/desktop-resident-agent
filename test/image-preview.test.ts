import { describe, expect, it } from 'vitest'
import { isImageAttachmentName } from '../src/shared/image-preview'

describe('isImageAttachmentName', () => {
  it('accepts the formats the app previews, regardless of case', () => {
    expect(isImageAttachmentName('image.png')).toBe(true)
    expect(isImageAttachmentName('SCREEN.JPG')).toBe(true)
    expect(isImageAttachmentName('photo.jpeg')).toBe(true)
    expect(isImageAttachmentName('anim.gif')).toBe(true)
    expect(isImageAttachmentName('shot.webp')).toBe(true)
  })

  it('keeps everything else out — text, binaries, extensionless names, lookalikes', () => {
    expect(isImageAttachmentName('notes.txt')).toBe(false)
    expect(isImageAttachmentName('report.docx')).toBe(false)
    expect(isImageAttachmentName('png')).toBe(false)
    expect(isImageAttachmentName('archive.png.zip')).toBe(false)
  })
})
