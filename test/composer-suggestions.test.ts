import { describe, expect, it } from 'vitest';
import { detectComposerTrigger, fileMention, sessionSuggestionItems, workflowSuggestionItems } from '../src/renderer/composer-suggestions';
import type { ConversationSummary } from '../src/shared/contracts';

describe('composer trigger detection', () => {
  it('offers workflows only at the beginning of the draft', () => {
    expect(detectComposerTrigger('/compact', 8)).toEqual({ kind: 'workflow', query: 'compact', start: 0, end: 8 });
    expect(detectComposerTrigger('请运行 /compact', 11)).toBeNull();
    expect(detectComposerTrigger('  /compact', 10)).toEqual({ kind: 'workflow', query: 'compact', start: 2, end: 10 });
  });

  it('offers $ skills separately from / commands and leaves completed tokens alone', () => {
    expect(detectComposerTrigger('$review', 7)).toEqual({ kind: 'skill', query: 'review', start: 0, end: 7 });
    expect(detectComposerTrigger('  $review', 9)).toEqual({ kind: 'skill', query: 'review', start: 2, end: 9 });
    expect(detectComposerTrigger('请用 $review', 10)).toBeNull();
    expect(detectComposerTrigger('$review file', 7)).toBeNull();
    expect(detectComposerTrigger('/compact now', 8)).toBeNull();
  });

  it('offers files after a word boundary without interpreting email addresses', () => {
    expect(detectComposerTrigger('请看 @notes', 9)).toEqual({ kind: 'file', query: 'notes', start: 3, end: 9 });
    expect(detectComposerTrigger('a@example.com', 13)).toBeNull();
    expect(detectComposerTrigger('请看 @notes more', 9)).toBeNull();
    expect(detectComposerTrigger('请看 @{notes/file.md}', 19)).toBeNull();
    expect(detectComposerTrigger('请看 @"my notes/file.md"', 21)).toBeNull();
    expect(detectComposerTrigger('@{notes/file.md}', 1)).toBeNull();
    expect(detectComposerTrigger('@"my notes/file.md"', 1)).toBeNull();
    expect(detectComposerTrigger('@[session](id)', 1)).toBeNull();
  });

  it('lists only commands for / and only skills for $', () => {
    const options = [
      { name: 'review', kind: 'command' as const, source: 'project' as const, description: 'Run a review' },
      { name: 'review', kind: 'skill' as const, source: 'user' as const, description: 'Review with a skill' },
      { name: 'compact', kind: 'command' as const, source: 'builtin' as const, description: 'Shrink context' },
    ];
    expect(workflowSuggestionItems(options, { kind: 'workflow', query: 'review', start: 0, end: 7 })).toEqual([
      { id: 'command:project:review', label: '/review', detail: '命令，项目，Run a review', insertText: '/review' },
    ]);
    expect(workflowSuggestionItems(options, { kind: 'skill', query: 'REVIEW', start: 0, end: 7 })).toEqual([
      { id: 'skill:user:review', label: '$review', detail: '技能，用户，Review with a skill', insertText: '$review' },
    ]);
    expect(workflowSuggestionItems(options, { kind: 'file', query: 'review', start: 0, end: 7 })).toEqual([]);
  });

  it('quotes file paths with spaces and normalizes Windows separators', () => {
    expect(fileMention('docs\\task.md')).toBe('@{docs/task.md}');
    expect(fileMention('my notes\\task.md')).toBe('@"my notes/task.md"');
  });

  it('offers recent completed sessions as ID-backed references, including archived ones', () => {
    const ids = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    ];
    const summaries = ids.map((id, index): ConversationSummary => ({
      id, title: ['当前会话', '项目计划', '旧项目计划'][index],
      createdAt: '2026-10-13T00:00:00Z', updatedAt: `2026-10-13T0${index}:00:00Z`, lastActivityAt: `2026-10-13T0${index}:00:00Z`,
      archivedAt: index === 2 ? '2026-10-13T03:00:00Z' : null,
      pinnedAt: null, mode: 'dsh', taskStatus: 'idle', messageCount: index === 0 ? 1 : 4, preview: ''
    }));
    const matches = sessionSuggestionItems(summaries, '计划', ids[0]);
    expect(matches.map((item) => item.label)).toEqual(['旧项目计划', '项目计划']);
    expect(matches[0].detail).toContain('已归档');
    expect(matches[0].insertText).toBe(`@[旧项目计划](xiaojing-session:${ids[2]})`);
    expect(sessionSuggestionItems(summaries, '', ids[0]).every((item) => item.id !== `session:${ids[0]}`)).toBe(true);
  });
});
