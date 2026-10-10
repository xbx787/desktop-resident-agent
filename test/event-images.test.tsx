import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EventImages, eventImageCache, eventImageCandidates, remainingFiles } from '../src/renderer/event-images'

describe('eventImageCandidates', () => {
  it('prefers structured images and falls back to image-looking names for old messages', () => {
    expect(eventImageCandidates([{ name: 'a.png', path: 'D:\\a.png' }], 'a.png、notes.txt'))
      .toEqual([{ name: 'a.png', path: 'D:\\a.png' }])
    expect(eventImageCandidates(undefined, 'shot.png、notes.txt'))
      .toEqual([{ name: 'shot.png', path: '', inferred: true }])
    expect(eventImageCandidates(undefined, '仅文字.txt')).toEqual([])
  })
})

describe('remainingFiles', () => {
  it('drops the names shown as pictures', () => {
    expect(remainingFiles('shot.png、notes.txt', [{ name: 'shot.png', path: '' }])).toBe('notes.txt')
    expect(remainingFiles('a.png、b.png', [{ name: 'a.png', path: '' }, { name: 'b.png', path: '' }])).toBe('')
  })
})

describe('EventImages', () => {
  it('renders cached thumbnails above the text and keeps only non-image names in the file line', () => {
    eventImageCache.set('D:\\a.png', 'data:image/png;base64,AAA')
    const html = renderToStaticMarkup(<EventImages note={{ prompt: '正文内容', files: 'a.png、notes.txt' }} prompt="正文内容"
      images={[{ name: 'a.png', path: 'D:\\a.png' }]} onOpen={() => {}} />)
    expect(html).toContain('data:image/png;base64,AAA')
    expect(html).toContain('查看图片 a.png')
    expect(html).toContain('附件 notes.txt')
    expect(html).not.toContain('a.png、notes.txt')
    // The picture sits above the user's words; the file line below both.
    expect(html.indexOf('data:image/png;base64,AAA')).toBeLessThan(html.indexOf('正文内容'))
    expect(html.indexOf('正文内容')).toBeLessThan(html.indexOf('附件 notes.txt'))
  })

  it('keeps an inferred name in the file line when its preview cannot be read', () => {
    eventImageCache.set('ghost.png', null)
    const html = renderToStaticMarkup(<EventImages note={{ prompt: '看图', files: 'ghost.png' }} prompt="看图" onOpen={() => {}} />)
    expect(html).toContain('附件 ghost.png')
    expect(html).not.toContain('<img')
  })
})
