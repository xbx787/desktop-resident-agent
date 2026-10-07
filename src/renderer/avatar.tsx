import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BalanceSnapshot, PetAPI } from '../shared/contracts';
import { WhalePortrait } from './WhalePortrait';
import { BalanceCard } from './balance';
import { PanelBubble } from './panel';
import { petBridge, usePetState } from './pet-state';
import './avatar.css';

interface PointerSession {
  id: number;
  screenX: number;
  screenY: number;
  moved: boolean;
}

function hasMoved(session: PointerSession, event: React.PointerEvent<HTMLButtonElement>): boolean {
  return Math.hypot(event.screenX - session.screenX, event.screenY - session.screenY) >= 5;
}

function samePosition(a: { x: number; y: number } | null, b: { x: number; y: number }): boolean {
  return Boolean(a && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5);
}

function Avatar() {
  const { snapshot, error, run } = usePetState();
  const [panelOpen, setPanelOpen] = useState(false);
  const [balanceOpen, setBalanceOpen] = useState(false);
  const [balanceSnapshot, setBalanceSnapshot] = useState<BalanceSnapshot | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const balanceRefreshId = useRef(0);
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuFirstRef = useRef<HTMLButtonElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement | null>(null);
  const menuDesiredRef = useRef(false);
  const menuShapeQueue = useRef<Promise<void>>(Promise.resolve());
  const pointer = useRef<PointerSession | null>(null);
  const lastPointerPosition = useRef({ x: 0, y: 0 });
  const lastMoveSent = useRef<{ x: number; y: number } | null>(null);
  const dragQueue = useRef<Promise<void>>(Promise.resolve());
  const moveFrame = useRef<number | null>(null);
  const moveQueued = useRef(false);
  const moveDirty = useRef(false);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    let bridge: PetAPI;
    try {
      bridge = petBridge();
    } catch {
      return;
    }
    const unsubscribe = bridge.onPanelOpen((open) => {
      if (active) {
        receivedUpdate = true;
        setPanelOpen(open);
      }
    });
    const unsubscribeBalance = bridge.onBalanceOpen((open) => {
      if (!active) return;
      setBalanceOpen(open);
      if (open) void refreshBalance();
    });
    void bridge.getPanelOpen().then((open) => {
      if (active && !receivedUpdate) setPanelOpen(open);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
      unsubscribeBalance();
    };
  }, []);

  async function refreshBalance() {
    const requestId = ++balanceRefreshId.current;
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      const next = await petBridge().getBalance();
      if (requestId === balanceRefreshId.current) setBalanceSnapshot(next);
    } catch (cause) {
      if (requestId === balanceRefreshId.current) setBalanceError(cause instanceof Error ? cause.message : '余额查询失败。');
    } finally {
      if (requestId === balanceRefreshId.current) setBalanceLoading(false);
    }
  }

  function setMenuRegion(open: boolean): Promise<boolean> {
    const result = menuShapeQueue.current.then(() => run((bridge) => bridge.setMenuOpen(open)));
    menuShapeQueue.current = result.then(() => undefined);
    return result;
  }

  function closeContextMenu(restoreFocus = false) {
    if (!menuDesiredRef.current && !menu) return;
    menuDesiredRef.current = false;
    setMenu(false);
    if (restoreFocus) requestAnimationFrame(() => menuReturnFocusRef.current?.focus());
    requestAnimationFrame(() => {
      if (!menuDesiredRef.current) void setMenuRegion(false);
    });
  }

  useEffect(() => {
    const closeOnBlur = () => closeContextMenu();
    window.addEventListener('blur', closeOnBlur);
    return () => window.removeEventListener('blur', closeOnBlur);
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    menuFirstRef.current?.focus();
    const closeOutside = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeContextMenu();
    };
    const closeOnFocusLeave = (event: FocusEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) closeContextMenu();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeContextMenu(true);
      }
    };
    document.addEventListener('pointerdown', closeOutside, true);
    document.addEventListener('focusin', closeOnFocusLeave);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true);
      document.removeEventListener('focusin', closeOnFocusLeave);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu]);

  async function openContextMenu(event: React.MouseEvent<HTMLElement>) {
    event.preventDefault();
    if (!(event.target as HTMLElement).closest('.avatar-hit-target, .panel-bubble')) return;
    menuReturnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    menuDesiredRef.current = true;
    const accepted = await setMenuRegion(true);
    if (!accepted) {
      menuDesiredRef.current = false;
      return;
    }
    if (menuDesiredRef.current) {
      requestAnimationFrame(() => {
        if (menuDesiredRef.current) setMenu(true);
      });
    }
  }

  function queueDrag(action: (bridge: PetAPI) => Promise<void>) {
    dragQueue.current = dragQueue.current.then(async () => {
      await run(action);
    });
  }

  function queueMove() {
    if (samePosition(lastMoveSent.current, lastPointerPosition.current)) return;
    moveDirty.current = true;
    if (moveQueued.current) return;
    moveQueued.current = true;
    queueDrag(async (bridge) => {
      try {
        while (moveDirty.current) {
          moveDirty.current = false;
          const position = { ...lastPointerPosition.current };
          if (!samePosition(lastMoveSent.current, position)) {
            lastMoveSent.current = position;
            await bridge.dragMove(position);
          }
        }
      } finally {
        moveQueued.current = false;
      }
    });
  }

  function flushMove() {
    if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    queueMove();
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || pointer.current || menu) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = { x: event.screenX, y: event.screenY };
    lastPointerPosition.current = position;
    lastMoveSent.current = null;
    pointer.current = {
      id: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false,
    };
    // Invoke IPC in this pointerdown turn. Deferring it through a Promise.then
    // lets a fast drag move the OS cursor before main samples its origin.
    dragQueue.current = run((bridge) => bridge.beginDrag(position)).then(() => undefined);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLButtonElement>) {
    const session = pointer.current;
    if (!session || session.id !== event.pointerId) return;
    if (samePosition(lastPointerPosition.current, { x: event.screenX, y: event.screenY })) return;
    lastPointerPosition.current = { x: event.screenX, y: event.screenY };
    if (hasMoved(session, event)) {
      session.moved = true;
    }
    if (session.moved && moveFrame.current === null) {
      moveFrame.current = requestAnimationFrame(() => {
        moveFrame.current = null;
        queueMove();
      });
    }
  }

  function finishPointer(event: React.PointerEvent<HTMLButtonElement>, cancelled = false) {
    const session = pointer.current;
    if (!session || session.id !== event.pointerId) return;
    pointer.current = null;
    if (!cancelled) lastPointerPosition.current = { x: event.screenX, y: event.screenY };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const moved = session.moved || (!cancelled && hasMoved(session, event));
    if (moved) flushMove();
    else if (moveFrame.current !== null) {
      cancelAnimationFrame(moveFrame.current);
      moveFrame.current = null;
    }
    queueDrag((bridge) => bridge.endDrag());
    if (!moved && !cancelled) {
      queueDrag((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
    }
  }

  return (
    <main className={`avatar-stage${panelOpen ? ' is-panel-open' : ''}${snapshot?.avatarState === 'speaking' ? ' is-speaking' : snapshot?.avatarState === 'listening' ? ' is-listening' : ''}`} onContextMenu={(event) => { void openContextMenu(event); }}>
      <PanelBubble
        visible={panelOpen}
        snapshot={snapshot}
        error={error}
        run={run}
      />
      <BalanceCard
        visible={balanceOpen}
        snapshot={balanceSnapshot}
        loading={balanceLoading}
        error={balanceError}
        onRefresh={() => { void refreshBalance(); }}
        onClose={() => { void run((bridge) => bridge.setBalanceOpen(false)); }}
      />
      {menu && <div ref={menuRef} className="avatar-context-menu" role="menu" aria-label="角色菜单">
        <button ref={menuFirstRef} type="button" role="menuitem" className="avatar-menu-action avatar-menu-exit" onClick={() => { closeContextMenu(); void run((bridge) => bridge.quit()); }}>退出</button>
      </div>}
      <button
        className="avatar-hit-target"
        type="button"
        aria-label="桌面角色，单击切换聊天气泡，拖动可移动位置"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          void run((bridge) => bridge.setBalanceOpen(!balanceOpen));
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            void run((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
          }
        }}
      >
        <WhalePortrait />
      </button>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Avatar />);
