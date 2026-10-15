import { useEffect, useMemo, useState } from 'react'
import { isImageAttachmentName } from '../shared/image-preview'
import { petBridge } from './pet-state'
import { fileBadge, type AttachmentNote } from './attachment-note'
import type { TimelineEntry } from '../shared/contracts'

/** Read once per key and keep it (null marks a failed read): switching
 *  conversations re-mounts the message rows, and re-reading every image each
 *  time is pure waste. */
export const eventImageCache = new Map<string, string | null>()

export interface EventImage {
  name: string
  path: string
  /** Inferred from a historical message's file list — only its name is known,
   *  and a failed read leaves the name in the files line. */
  inferred?: boolean
}

/** The pictures a message should show: structured images first; for messages
 *  recorded before that field existed, image-looking file names are tried by
 *  name inside the app's own attachments directory. */
export function eventImageCandidates(images: TimelineEntry['images'], files: string): EventImage[] {
  if (images?.length) return images.map(({ name, path }) => ({ name, path }))
  return files.split('、').map((name) => name.trim())
    .filter((name) => name && isImageAttachmentName(name))
    .map((name) => ({ name, path: '', inferred: true }))
}

/** The files line with the names that are shown as pictures removed. */
export function remainingFiles(files: string, shown: readonly EventImage[]): string {
  const hidden = new Set(shown.map((image) => image.name))
  return files.split('、').map((name) => name.trim()).filter((name) => name && !hidden.has(name)).join('、')
}

/**
 * A user message's attachments: the pictures render as thumbnails above the
 * text (click one to open the viewer), the user's words follow, and anything
 * that is not an image stays a quiet file line below. Historical messages are
 * served the same way by trying image-looking names.
 */
export function EventImages({ note, prompt, images, onOpen }: {
  note: AttachmentNote
  prompt: string
  images?: TimelineEntry['images']
  onOpen: (name: string, url: string) => void
}) {
  const candidates = useMemo(() => eventImageCandidates(images, note.files), [images, note.files])
  const [resolved, setResolved] = useState<Record<string, string | null>>(() => {
    const initial: Record<string, string | null> = {}
    for (const image of candidates) {
      const key = image.path || image.name
      if (eventImageCache.has(key)) initial[key] = eventImageCache.get(key)!
    }
    return initial
  })
  useEffect(() => {
    let cancelled = false
    void (async () => {
      for (const image of candidates) {
        const key = image.path || image.name
        if (eventImageCache.has(key)) continue
        let url: string | null = null
        try {
          url = await petBridge().readImagePreview(key)
        } catch {
          url = null
        }
        eventImageCache.set(key, url)
        if (!cancelled) setResolved((current) => ({ ...current, [key]: url }))
      }
    })()
    return () => { cancelled = true }
  }, [candidates])

  const shown = candidates.filter((image) => resolved[image.path || image.name])
  const remainder = remainingFiles(note.files, shown)
  return <>
    {shown.length > 0 && <div className="panel-event-images">
      {shown.map((image) => {
        const url = resolved[image.path || image.name]!
        return <button key={image.name} type="button" className="panel-event-image" aria-label={`查看图片 ${image.name}`} title={image.name}
          onClick={() => onOpen(image.name, url)}>
          <img src={url} alt={image.name} loading="lazy" />
        </button>
      })}
    </div>}
    <p>{prompt}</p>
    {remainder && <div className="panel-event-attachments">
      <span className="panel-event-attachment-line" aria-hidden="true" />
      <div className="panel-event-file-list" aria-label={`附件 ${remainder}`}>
        {remainder.split('、').map((name) => {
          const badge = fileBadge(name)
          return <span key={name} className="panel-event-file" title={name}>
            <i aria-hidden="true">{badge.kind}</i>
            <span>{badge.stem}</span>
          </span>
        })}
      </div>
    </div>}
  </>
}
