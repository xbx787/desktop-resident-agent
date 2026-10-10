import { describe, expect, it } from 'vitest';
import { detectComposerTrigger, fileMention } from '../src/renderer/composer-suggestions';

describe('composer trigger detection', () => {
  it('offers workflows only at the beginning of the draft', () => {
    expect(detectComposerTrigger('/compact', 8)).toEqual({ kind: 'workflow', query: 'compact', start: 0, end: 8 });
    expect(detectComposerTrigger('请运行 /compact', 11)).toBeNull();
  });

  it('offers files after a word boundary without interpreting email addresses', () => {
    expect(detectComposerTrigger('请看 @notes', 9)).toEqual({ kind: 'file', query: 'notes', start: 3, end: 9 });
    expect(detectComposerTrigger('a@example.com', 13)).toBeNull();
  });

  it('quotes file paths with spaces and normalizes Windows separators', () => {
    expect(fileMention('docs\\task.md')).toBe('@{docs/task.md}');
    expect(fileMention('my notes\\task.md')).toBe('@"my notes/task.md"');
  });
});
