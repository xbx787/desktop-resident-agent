import { describe, expect, it } from 'vitest'
import { fileBadge, splitAttachmentNote } from '../src/renderer/attachment-note'

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

describe('fileBadge', () => {
  it('splits a plain extension into a badge and a stem', () => {
    expect(fileBadge('报告.docx')).toEqual({ kind: 'DOCX', stem: '报告' })
    expect(fileBadge('27考研政治随身背专题5-6.pdf')).toEqual({ kind: 'PDF', stem: '27考研政治随身背专题5-6' })
    // The last extension is the badge; the rest stays in the stem.
    expect(fileBadge('a.tar.gz')).toEqual({ kind: 'GZ', stem: 'a.tar' })
  })

  it('keeps names without a usable extension whole', () => {
    expect(fileBadge('说明')).toEqual({ kind: '文件', stem: '说明' })
    expect(fileBadge('.env')).toEqual({ kind: '文件', stem: '.env' })
    expect(fileBadge('a.')).toEqual({ kind: '文件', stem: 'a.' })
    expect(fileBadge('奇怪.后缀名太长')).toEqual({ kind: '文件', stem: '奇怪.后缀名太长' })
  })
})
