import type { UserAttachment } from '../shared/contracts';

export interface StashedComposer<A = UserAttachment> {
  draft: string;
  attachments: A[];
}

/** Saves copies of the live composer state under a conversation id so switching away never drops them. */
export function stashComposerState<A>(stash: Map<string, StashedComposer<A>>, id: string | null | undefined, draft: string, attachments: A[]): void {
  if (!id) return;
  stash.set(id, { draft, attachments: [...attachments] });
}

/** Returns a copy of the stored composer state, or an empty one when the conversation has none. */
export function restoreComposerState<A>(stash: Map<string, StashedComposer<A>>, id: string | null | undefined): StashedComposer<A> {
  const saved = id ? stash.get(id) : undefined;
  return saved ? { draft: saved.draft, attachments: [...saved.attachments] } : { draft: '', attachments: [] };
}

/** Clipboard files, including bitmaps that arrive without a disk path. */
export function pastedFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files = Array.from(data.files);
  if (files.length) return files;
  return Array.from(data.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((file): file is File => file !== null);
}

/** Names unnamed clipboard images by their media type so the staged temp path stays readable. */
export function pastedFileName(file: { name: string; type: string }): string {
  if (file.name) return file.name;
  const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[file.type] ?? 'bin';
  return `粘贴附件.${extension}`;
}
