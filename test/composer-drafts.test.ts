import { describe, expect, it } from 'vitest';
import { pastedFileName, pastedFiles, restoreComposerState, stashComposerState, type StashedComposer } from '../src/renderer/composer-drafts';

describe('composer draft stash', () => {
  it('stores copies so later edits to the live composer do not rewrite the stash', () => {
    const stash = new Map<string, StashedComposer<{ name: string }>>();
    const attachments = [{ name: 'a.txt' }];
    stashComposerState(stash, 'conv-1', 'half draft', attachments);
    attachments.push({ name: 'b.txt' });
    expect(restoreComposerState(stash, 'conv-1')).toEqual({ draft: 'half draft', attachments: [{ name: 'a.txt' }] });
  });

  it('returns empty state for unknown or missing ids and ignores stashing without an id', () => {
    const stash = new Map<string, StashedComposer>();
    expect(restoreComposerState(stash, 'unknown')).toEqual({ draft: '', attachments: [] });
    stashComposerState(stash, null, 'draft', []);
    expect(stash.size).toBe(0);
  });

  it('returns copies so mutating a restore does not corrupt the stash', () => {
    const stash = new Map<string, StashedComposer>();
    stashComposerState(stash, 'conv-1', 'text', [{ name: 'a.txt', content: 'a' }]);
    const restored = restoreComposerState(stash, 'conv-1');
    restored.attachments.push({ name: 'b.txt', content: 'b' });
    restored.draft = 'changed';
    expect(restoreComposerState(stash, 'conv-1')).toEqual({ draft: 'text', attachments: [{ name: 'a.txt', content: 'a' }] });
  });
});

describe('clipboard paste collection', () => {
  it('collects files directly from the clipboard list and tolerates a missing clipboard', () => {
    const file = new File(['x'], 'shot.png', { type: 'image/png' });
    expect(pastedFiles({ files: [file], items: [] } as unknown as DataTransfer)).toEqual([file]);
    expect(pastedFiles(null)).toEqual([]);
  });

  it('falls back to file items when the files list is empty', () => {
    const file = new File(['x'], 'note.txt', { type: 'text/plain' });
    const data = { files: [], items: [{ kind: 'string', getAsFile: () => null }, { kind: 'file', getAsFile: () => file }] } as unknown as DataTransfer;
    expect(pastedFiles(data)).toEqual([file]);
  });

  it('names unnamed clipboard images by their media type', () => {
    expect(pastedFileName({ name: '', type: 'image/png' })).toBe('粘贴附件.png');
    expect(pastedFileName({ name: '', type: 'application/octet-stream' })).toBe('粘贴附件.bin');
    expect(pastedFileName({ name: 'report.pdf', type: 'application/pdf' })).toBe('report.pdf');
  });
});
