import { useEffect, useRef, type MouseEvent } from 'react';
import type { ClaudeWorkflowOption, ConversationSummary } from '../shared/contracts';
import { sessionMentionToken } from '../shared/session-mentions';

export interface ComposerTrigger {
  kind: 'file' | 'workflow' | 'skill';
  query: string;
  start: number;
  end: number;
}

export interface ComposerSuggestion {
  id: string;
  label: string;
  detail: string;
  insertText: string;
}

export function detectComposerTrigger(text: string, caret: number): ComposerTrigger | null {
  const position = Math.max(0, Math.min(caret, text.length));
  const before = text.slice(0, position);
  const after = text.slice(position);
  // The SDK accepts commands and skills only at the start of a submitted
  // message. Keep an already completed token out of the picker when the caret
  // sits just before its separating space.
  const workflow = /^(\s*)([/$])([^\s/$]*)$/.exec(before);
  if (workflow && !/^\s/u.test(after)) {
    return { kind: workflow[2] === '$' ? 'skill' : 'workflow', query: workflow[3], start: workflow[1].length, end: position };
  }
  const file = /(^|[\s([{])@([^\s@{}"']*)$/.exec(before);
  // The canonical @{path}, @"path" and markdown mention forms are already
  // complete tokens, including when the caret is placed just after their @.
  if (file && !/^\s/u.test(after) && !(file[2] === '' && /^[{"\[]/u.test(after))) {
    return { kind: 'file', query: file[2], start: before.length - file[2].length - 1, end: position };
  }
  return null;
}

/** The picker keeps /commands and $skills distinct, while the main process
 * still resolves either submitted token through the native Claude workflow. */
export function workflowSuggestionItems(options: readonly ClaudeWorkflowOption[], trigger: ComposerTrigger): ComposerSuggestion[] {
  if (trigger.kind === 'file') return [];
  const kind = trigger.kind === 'skill' ? 'skill' : 'command';
  const prefix = kind === 'skill' ? '$' : '/';
  const query = trigger.query.toLocaleLowerCase();
  return options
    .filter((option) => option.kind === kind)
    .filter((option) => option.name.replace(/^[/\$]+/u, '').toLocaleLowerCase().includes(query))
    .slice(0, 50)
    .map((option) => {
      const name = option.name.replace(/^[/\$]+/u, '');
      return {
        id: `${option.kind}:${option.source}:${name}`,
        label: `${prefix}${name}`,
        detail: `${kind === 'skill' ? '技能' : '命令'}，${option.source === 'project' ? '项目' : option.source === 'builtin' ? '内置' : '用户'}${option.description ? `，${option.description}` : ''}`,
        insertText: `${prefix}${name}`,
      };
    });
}

/** Session references use an ID-backed token, so later renames cannot change
 * which conversation the model sees. Empty @ offers recent completed chats. */
export function sessionSuggestionItems(conversations: readonly ConversationSummary[], query: string,
  activeId: string | null, limit = 4): ComposerSuggestion[] {
  const term = query.trim().toLocaleLowerCase();
  return conversations
    .filter((item) => item.id !== activeId && item.messageCount >= 2 && item.title.toLocaleLowerCase().includes(term))
    .sort((a, b) => {
      if (term) {
        const ap = a.title.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        const bp = b.title.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        if (ap !== bp) return ap - bp;
      }
      return Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) || b.updatedAt.localeCompare(a.updatedAt);
    })
    .slice(0, Math.max(0, limit))
    .flatMap((item) => {
      try {
        return [{
          id: `session:${item.id}`,
          label: item.title,
          detail: `会话，${item.messageCount} 条消息${item.archivedAt ? '，已归档' : ''}`,
          insertText: sessionMentionToken(item.title, item.id)
        }];
      } catch {
        // A legacy record with an invalid identifier cannot be resolved at
        // send time, so never offer a broken token in the picker.
        return [];
      }
    });
}

export function fileMention(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/');
  return /[\s{}]/.test(normalized) ? `@"${normalized}"` : `@{${normalized}}`;
}

export function ComposerSuggestions({ kind, query, items, selectedIndex, loading, failed = false, onSelect }: {
  kind: ComposerTrigger['kind'];
  query: string;
  items: ComposerSuggestion[];
  selectedIndex: number;
  loading: boolean;
  failed?: boolean;
  onSelect: (item: ComposerSuggestion) => void;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  // Keyboard navigation has to drag the list along with it — including the jump
  // from the first row up to the last one, which otherwise sits out of sight.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, items]);
  const empty = !items.length && !loading && !failed;
  const emptyHint = query.trim().length === 0
    ? kind === 'file' ? '输入文件名查找' : kind === 'skill' ? '没有可用技能' : '没有可用命令'
    : '没有匹配内容';
  const keepEditorFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  return <div id="panel-composer-suggestions" ref={listRef} className="panel-composer-suggestions" role="listbox" aria-label={kind === 'file' ? '引用文件' : kind === 'skill' ? '选择技能' : '选择命令'}>
    {loading && !items.length && <div className="panel-suggestion-loading" role="status">正在查找…</div>}
    {!loading && failed && <div className="panel-suggestion-note" role="status">查找失败，继续输入可重试</div>}
    {empty && <div className="panel-suggestion-note" role="status">{emptyHint}</div>}
    {items.map((item, index) => <button
      key={item.id}
      id={`panel-suggestion-${index}`}
      type="button"
      role="option"
      aria-selected={selectedIndex === index}
      className="panel-suggestion-item"
      onMouseDown={keepEditorFocus}
      onClick={() => onSelect(item)}
    ><span>{item.label}</span><small>{item.detail}</small></button>)}
  </div>;
}
