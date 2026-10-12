import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './tab-context-menu.css';

export interface TurnContextMenuProps {
  title: string;
  /** Pointer coordinates relative to the chat bubble. */
  x: number;
  y: number;
  /** The .panel-bubble element; the portal keeps the menu outside clipped content. */
  container: HTMLElement;
  /** The turn is still running; deletion is refused until it settles. */
  running: boolean;
  onDelete: () => void;
  onClose: () => void;
}

function DeleteIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 6h11M8 6V4.5h4V6m-6 0 .6 10h6.8L14 6M8.5 9v4.5m3-4.5v4.5" /></svg>;
}

/** Right-click menu for one turn's avatar: deleting removes the whole turn —
 *  the message, its thinking chain, tools and reply — from the visible
 *  timeline and from what the model remembers. Two taps on purpose: the item
 *  flips into its own confirmation before anything is removed. */
export function TurnContextMenu({ title, x, y, container, running, onDelete, onClose }: TurnContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const [confirming, setConfirming] = useState(false);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const margin = 8;
    const left = Math.max(margin, Math.min(x + 3, container.clientWidth - menu.offsetWidth - margin));
    const top = Math.max(margin, Math.min(y + 3, container.clientHeight - menu.offsetHeight - margin));
    setPosition({ left, top });
    (menu.querySelector('button:not(:disabled)') as HTMLButtonElement | null)?.focus();
  }, [container, x, y, confirming]);

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

  return createPortal(
    <div ref={menuRef} className="tab-context-menu" role="menu" aria-label={`这一轮对话：${title}`} style={position ?? { left: x, top: y, visibility: 'hidden' }}>
      <div className="tab-context-menu-title" title={title}>{title}</div>
      {confirming
        ? <div className="turn-menu-confirm">
          <span>这一轮的发言、思考链与回复将全部删除，无法恢复；下一轮起我也不再记得它。</span>
          <div className="turn-menu-confirm-actions">
            <button type="button" role="menuitem" className="is-danger" disabled={running} onClick={() => { closeRef.current(); onDelete(); }}>删除</button>
            <button type="button" role="menuitem" onClick={() => setConfirming(false)}>取消</button>
          </div>
        </div>
        : <button type="button" role="menuitem" className="is-danger" disabled={running} title={running ? '这一轮还在运行，结束后才能删除' : '删除这一轮对话'} onClick={() => setConfirming(true)}><DeleteIcon />删除这一轮</button>}
    </div>,
    container,
  );
}
