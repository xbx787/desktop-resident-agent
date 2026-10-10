import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tab-context-menu.css';

export interface TabContextMenuProps {
  title: string;
  /** Pointer coordinates relative to the chat bubble. */
  x: number;
  y: number;
  /** The .panel-bubble element; the portal keeps the menu outside clipped content. */
  container: HTMLElement;
  busy: boolean;
  running: boolean;
  current: boolean;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClose: () => void;
}

function Icon({ kind }: { kind: 'rename' | 'archive' | 'delete' }) {
  if (kind === 'rename') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 13 9-9 3 3-9 9-4 1 1-4ZM11.5 5.5l3 3" /></svg>;
  if (kind === 'archive') return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 5h13v3h-13zM5 8v8h10V8M8 11h4" /></svg>;
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .6 10h6.8L14 6M8.5 9v4.5m3-4.5v4.5" /></svg>;
}

export function TabContextMenu({ title, x, y, container, busy, running, current, onRename, onArchive, onDelete, onClose }: TabContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const cannotRemove = busy || (running && current);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(x + 3, container.clientWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(y + 3, container.clientHeight - menu.offsetHeight - margin));
    setPosition({ left, top });
    (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
  }, [container, x, y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeRef.current();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    document.addEventListener('pointerdown', closeOutside, true);
    // Window capture runs before the document's Esc-to-interrupt listener.
    window.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('keydown', closeOnEscape, true);
    };
  }, []);

  const invoke = (action: () => void) => {
    closeRef.current();
    action();
  };

  return createPortal(
    <div ref={menuRef} className="tab-context-menu" role="menu" aria-label={`会话操作：${title}`} style={position ?? { left: x, top: y, visibility: 'hidden' }}>
      <div className="tab-context-menu-title" title={title}>{title}</div>
      <button type="button" role="menuitem" disabled={busy} title="重命名会话" onClick={() => invoke(onRename)}><Icon kind="rename" />重命名</button>
      <button type="button" role="menuitem" disabled={cannotRemove} title={cannotRemove ? '当前任务运行中，暂不能移除当前会话' : '归档会话'} onClick={() => invoke(onArchive)}><Icon kind="archive" />归档</button>
      <button type="button" role="menuitem" className="is-danger" disabled={cannotRemove} title={cannotRemove ? '当前任务运行中，暂不能移除当前会话' : '删除会话'} onClick={() => invoke(onDelete)}><Icon kind="delete" />删除</button>
    </div>,
    container,
  );
}
