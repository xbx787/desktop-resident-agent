export interface PreviewPlacement {
  /** Distance from the composer's left edge (the popover's containing block). */
  left: number
  /** The chip's own width — the preview is exactly as wide as its chip. */
  width: number
  /** Distance from the composer's bottom edge up to the chip's top, plus the gap. */
  bottom: number
}

/** Where the hover preview sits: same width as the chip, growing upward from
 *  just above it. Measured against the composer because the chip row scrolls
 *  horizontally and would clip anything anchored inside it. */
export function previewPlacement(
  composer: { left: number; bottom: number },
  chip: { left: number; top: number; width: number },
  gap = 6
): PreviewPlacement {
  return { left: Math.max(0, chip.left - composer.left), width: chip.width, bottom: composer.bottom - chip.top + gap }
}

/** The hover card above an attachment chip: the image at the chip's width,
 *  as tall as it needs to be. Non-interactive — it only has to be looked at. */
export function AttachmentPreview({ placement, name, src }: { placement: PreviewPlacement; name: string; src: string }) {
  return <span className="panel-attachment-preview" role="img" aria-label={`${name} 预览`}
    style={{ left: `${placement.left}px`, bottom: `${placement.bottom}px`, width: `${placement.width}px` }}>
    <img src={src} alt="" />
  </span>
}
