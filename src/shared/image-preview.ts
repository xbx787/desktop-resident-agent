/** Attachment names the composer can try to preview. The bytes are checked
 *  again in the main process, so a wrong extension simply yields no preview. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])

/** True when the name ends in an extension the app's image pipeline supports. */
export function isImageAttachmentName(name: string): boolean {
  const dot = name.lastIndexOf('.')
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}
