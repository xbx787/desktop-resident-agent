import { describe, expect, it } from 'vitest'
import { splitAttachmentNote } from '../src/renderer/attachment-note'

describe('splitAttachmentNote', () => {
  it('splits the prompt from the file list the runtime appended', () => {
    expect(splitAttachmentNote('看一下这张图\n附件：image.png')).toEqual({ prompt: '看一下这张图', files: 'image.png' })
    expect(splitAttachmentNote('对比两份\n附件：a.md、b.md')).toEqual({ prompt: '对比两份', files: 'a.md、b.md' })
  })

  it('falls back to the generic opener when nothing was typed', () => {
    expect(splitAttachmentNote('\n附件：a.png')).toEqual({ prompt: '请阅读附件并帮助我。', files: 'a.png' })
  })

  it('leaves ordinary text alone', () => {
    expect(splitAttachmentNote('普通的一句话')).toBeNull()
    expect(splitAttachmentNote('正文里提到 附件：这个词但不在末尾')).toBeNull()
    expect(splitAttachmentNote('前面\n附件：')).toBeNull()
  })
})
