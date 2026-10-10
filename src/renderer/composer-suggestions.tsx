import { useEffect, useRef, type MouseEvent } from 'react';

export interface ComposerTrigger {
  kind: 'file' | 'workflow';
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
  const before = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const workflow = /^\/([^\s/]*)$/.exec(before);
  if (workflow) return { kind: 'workflow', query: workflow[1], start: 0, end: before.length };
  const file = /(^|[\s([{])@([^\s@{}"']*)$/.exec(before);
  if (file) return { kind: 'file', query: file[2], start: before.length - file[2].length - 1, end: before.length };
  return null;
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
  // Silence is fine before the user has typed anything after the trigger, but a
  // finished search that found nothing — or failed — has to say so.
  const empty = !items.length && !loading && !failed;
  if (empty && query.trim().length === 0) return null;
  const keepEditorFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();
  return <div id="panel-composer-suggestions" ref={listRef} className="panel-composer-suggestions" role="listbox" aria-label={kind === 'file' ? '引用文件' : '命令与技能'}>
    {loading && !items.length && <div className="panel-suggestion-loading" role="status">正在查找…</div>}
    {!loading && failed && <div className="panel-suggestion-note" role="status">查找失败，继续输入可重试</div>}
    {empty && <div className="panel-suggestion-note" role="status">没有匹配内容</div>}
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
