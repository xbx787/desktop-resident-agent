import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { BalanceSnapshot, PetAPI } from '../shared/contracts';
import { WhalePortrait } from './WhalePortrait';
import { BalanceCard } from './balance';
import { balanceErrorMessage } from './balance-error';
import { PanelBubble } from './panel';
import { petBridge, usePetState } from './pet-state';
import { playClickBounce } from './avatar-motion';
import { startIdleFidgets } from './avatar-idle';
import { playPoseSwap, poseSrc, preloadPoses, startPoseClock } from './avatar-poses';
import { FACE_HOLD_MS, lastUserEntryId, SEND_FACE_HOLD_MS, stateFace, TASK_DOT_HOLD_MS, taskDot, type TaskDot } from './avatar-face';
import { playAhogeFlick } from './avatar-ahoge';
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
  const pointer = useRef<PointerSession | null>(null);
  const lastPointerPosition = useRef({ x: 0, y: 0 });
  const lastMoveSent = useRef<{ x: number; y: number } | null>(null);
  const dragQueue = useRef<Promise<void>>(Promise.resolve());
  const moveFrame = useRef<number | null>(null);
  const moveQueued = useRef(false);
  const moveDirty = useRef(false);
  const portraitRef = useRef<HTMLDivElement | null>(null);
  const ahogeRef = useRef<HTMLImageElement | null>(null);
  const [poseId, setPoseId] = useState<string | null>(null);
  const [faceId, setFaceId] = useState<string | null>(null);
  const faceIdRef = useRef<string | null>(null);
  faceIdRef.current = faceId;
  // A state face outranks the idle rotation; the clock below sits out.
  const faceActive = useRef(false);
  const faceHold = useRef<number | null>(null);
  // A send's smile owns the face for a beat: the state effect stands clear
  // until that window closes (it then re-reads the state and settles into
  // whatever the turn wants — usually the focus).
  const sendHold = useRef(false);
  // The shoulder dot: busy tones ride the status as long as it lasts; settled
  // ones show for a beat and fade, so "done" reads as a moment, not a state.
  const [dot, setDot] = useState<TaskDot | null>(null);
  const dotHold = useRef<number | null>(null);
  const taskStatus = snapshot?.taskStatus;
  useEffect(() => {
    const next = taskDot(taskStatus);
    if (dotHold.current !== null) { window.clearTimeout(dotHold.current); dotHold.current = null; }
    if (!next || next.pulse) { setDot(next); return; }
    setDot(next);
    dotHold.current = window.setTimeout(() => { dotHold.current = null; setDot(null); }, TASK_DOT_HOLD_MS);
  }, [taskStatus]);
  useEffect(() => () => { if (dotHold.current !== null) window.clearTimeout(dotHold.current); }, []);

  useEffect(() => startIdleFidgets(portraitRef.current), []);
  useEffect(() => {
    preloadPoses();
    return startPoseClock((pose) => {
      if (faceActive.current) return;
      playPoseSwap(portraitRef.current, () => setPoseId(pose ? pose.id : null));
    });
  }, []);

  // State faces: focus while a reply is being produced, a smile for a beat
  // once it lands. The smile window shields itself from the states that
  // follow it (a voice broadcast flips avatarState again right after), while
  // a new turn cancels any lingering smile immediately.
  const avatarState = snapshot?.avatarState;
  const avatarStateRef = useRef(avatarState);
  avatarStateRef.current = avatarState;
  useEffect(() => {
    if (sendHold.current) return;
    const face = stateFace(avatarState);
    if (face === 'focus') {
      if (faceHold.current !== null) {
        window.clearTimeout(faceHold.current);
        faceHold.current = null;
      }
      if (!faceActive.current || faceIdRef.current !== 'focus') {
        faceActive.current = true;
        playPoseSwap(portraitRef.current, () => setFaceId('focus'));
      }
      return;
    }
    if (face === 'smile') {
      if (faceHold.current !== null) return;
      faceActive.current = true;
      playPoseSwap(portraitRef.current, () => setFaceId('smile'));
      faceHold.current = window.setTimeout(() => {
        faceHold.current = null;
        faceActive.current = false;
        playPoseSwap(portraitRef.current, () => setFaceId(null));
      }, FACE_HOLD_MS);
      return;
    }
    if (faceHold.current !== null) return;
    if (faceActive.current) {
      faceActive.current = false;
      playPoseSwap(portraitRef.current, () => setFaceId(null));
    }
  }, [avatarState]);

  // A message the user just sent gets a beat of its own — the "heard you"
  // smile — before the turn's focus takes over. A first snapshot, an
  // unchanged newest message, or a different conversation is not a send.
  const lastUserRef = useRef<{ conversationId: string | undefined; entryId: string | null } | null>(null);
  useEffect(() => {
    const conversationId = snapshot?.conversationId;
    const entryId = snapshot ? lastUserEntryId(snapshot.timeline) : null;
    const previous = lastUserRef.current;
    lastUserRef.current = { conversationId, entryId };
    if (!previous || previous.conversationId !== conversationId || entryId === null || entryId === previous.entryId) return;
    sendHold.current = true;
    if (faceHold.current !== null) window.clearTimeout(faceHold.current);
    faceActive.current = true;
    playPoseSwap(portraitRef.current, () => setFaceId('smile'));
    faceHold.current = window.setTimeout(() => {
      faceHold.current = null;
      sendHold.current = false;
      const next = stateFace(avatarStateRef.current);
      if (next === 'smile') {
        // The reply landed inside the window — let that smile run its usual beat.
        faceHold.current = window.setTimeout(() => {
          faceHold.current = null;
          faceActive.current = false;
          playPoseSwap(portraitRef.current, () => setFaceId(null));
        }, FACE_HOLD_MS);
        return;
      }
      playPoseSwap(portraitRef.current, () => setFaceId(next));
      if (next === null) faceActive.current = false;
    }, SEND_FACE_HOLD_MS);
  }, [snapshot?.conversationId, snapshot?.timeline]);

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
    void bridge.getPanelOpen().then((open) => {
      if (active && !receivedUpdate) setPanelOpen(open);
    }).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  function openContextMenu(event: React.MouseEvent<HTMLElement>) {
    if (!(event.target as HTMLElement).closest('.avatar-hit-target')) return;
    event.preventDefault();
    void run((bridge) => bridge.showContextMenu());
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
    if (event.button !== 0 || pointer.current) return;
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
      // The poke plays straight from the pointer turn — queued IPC would make
      // the feedback wait behind the drag chain.
      playClickBounce(event.currentTarget);
      playAhogeFlick(ahogeRef.current);
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
      <button
        className="avatar-hit-target"
        type="button"
        aria-label="桌面角色，单击切换聊天气泡，拖动可移动位置"
        onMouseDown={(event) => {
          // Chromium starts Windows middle-button autoscroll on mousedown.
          // Cancelling auxclick alone is too late and can swallow later drags.
          if (event.button === 1) event.preventDefault();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishPointer(event)}
        onPointerCancel={(event) => finishPointer(event, true)}
        onLostPointerCapture={(event) => finishPointer(event, true)}
        onAuxClick={(event) => {
          if (event.button !== 1) return;
          event.preventDefault();
          void run((bridge) => bridge.toggleBalance());
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            playClickBounce(event.currentTarget);
            playAhogeFlick(ahogeRef.current);
            void run((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
          }
        }}
      >
        <WhalePortrait containerRef={portraitRef} ahogeRef={ahogeRef} artworkUrl={faceId ? poseSrc(faceId) : poseId ? poseSrc(poseId) : null} />
        {dot && <span className={`avatar-task-dot is-${dot.tone}${dot.pulse ? ' is-pulsing' : ''}`} aria-hidden="true" />}
      </button>
    </main>
  );
}

function BalanceOverlay() {
  const [snapshot, setSnapshot] = useState<BalanceSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshId = useRef(0);

  async function refreshBalance() {
    const requestId = ++refreshId.current;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    try {
      const next = await petBridge().getBalance();
      if (requestId === refreshId.current) setSnapshot(next);
    } catch (cause) {
      if (requestId === refreshId.current) setError(balanceErrorMessage(cause));
    } finally {
      if (requestId === refreshId.current) setLoading(false);
    }
  }

  useEffect(() => {
    const unsubscribe = petBridge().onBalanceOpen((open) => {
      if (open) void refreshBalance();
    });
    void refreshBalance();
    return () => {
      ++refreshId.current;
      unsubscribe();
    };
  }, []);

  return <BalanceCard
    visible={true}
    snapshot={snapshot}
    loading={loading}
    error={error}
    onRefresh={() => { void refreshBalance(); }}
    onClose={() => { void petBridge().setBalanceOpen(false).catch(() => setError('余额卡片暂时无法收起。')); }}
  />;
}

const balanceOnly = new URLSearchParams(window.location.search).get('balance') === '1';
if (balanceOnly) document.body.classList.add('balance-window');
createRoot(document.getElementById('root')!).render(balanceOnly ? <BalanceOverlay /> : <Avatar />);
