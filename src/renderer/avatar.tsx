import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AvatarBox, BalanceSnapshot, PetAPI } from '../shared/contracts';
import { WhalePortrait } from './WhalePortrait';
import { avatarArtFor } from './avatar-art';
import { BalanceCard } from './balance';
import { balanceErrorMessage } from './balance-error';
import { PanelBubble } from './panel';
import { petBridge, usePetState } from './pet-state';
import { cancelClickBounce, playClickBounce, prefersReducedMotion, watchReducedMotion } from './avatar-motion';
import { startIdleFidgets } from './avatar-idle';
import { cancelPoseSwap, playPoseSwap, poseSrc, preloadPoses, startPoseClock } from './avatar-poses';
import { FACE_HOLD_MS, FAILED_FACE_HOLD_MS, lastUserEntryId, resolveAvatarPresentation, SEND_FACE_HOLD_MS, TASK_DOT_HOLD_MS, taskDot, type TaskDot } from './avatar-face';
import { cancelAhogeFlick, playAhogeFlick } from './avatar-ahoge';
import './avatar.css';

interface PointerSession {
  id: number;
  screenX: number;
  screenY: number;
  moved: boolean;
  /** 会话建立时刻——丢失的抬起事件靠它自愈（见 handlePointerDown）。 */
  at: number;
}

function hasMoved(session: PointerSession, event: React.PointerEvent<HTMLButtonElement>): boolean {
  return Math.hypot(event.screenX - session.screenX, event.screenY - session.screenY) >= 5;
}

function samePosition(a: { x: number; y: number } | null, b: { x: number; y: number }): boolean {
  return Boolean(a && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5);
}

function Avatar() {
  const { snapshot, error, run } = usePetState();
  const personaId = snapshot?.conversationLibrary?.settings.personaId ?? 'xiaojing';
  const personaArt = avatarArtFor(personaId);
  const [panelOpen, setPanelOpen] = useState(false);
  const pointer = useRef<PointerSession | null>(null);
  const lastPointerPosition = useRef({ x: 0, y: 0 });
  const lastMoveSent = useRef<{ x: number; y: number } | null>(null);
  const dragQueue = useRef<Promise<void>>(Promise.resolve());
  const moveFrame = useRef<number | null>(null);
  const moveQueued = useRef(false);
  const moveDirty = useRef(false);
  const gestureRef = useRef<HTMLDivElement | null>(null);
  const idleRef = useRef<HTMLDivElement | null>(null);
  const swapRef = useRef<HTMLDivElement | null>(null);
  const idleStop = useRef<(() => void) | null>(null);
  const ahogeRef = useRef<HTMLImageElement | null>(null);
  const [poseId, setPoseId] = useState<string | null>(null);
  const [visibleArt, setVisibleArt] = useState<string | null>(null);
  const requestedArt = useRef<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [dragging, setDragging] = useState(false);
  const [interactionEpoch, setInteractionEpoch] = useState(0);
  const [acknowledging, setAcknowledging] = useState(false);
  const [settled, setSettled] = useState<'done' | 'failed' | null>(null);
  const sendTimer = useRef<number | null>(null);
  const outcomeTimer = useRef<number | null>(null);
  const avatarState = snapshot?.avatarState;
  const taskStatus = snapshot?.taskStatus;
  const presentation = resolveAvatarPresentation({ avatarState, taskStatus, acknowledging, settled, dragging });
  const desiredArt = personaArt.poses
    ? presentation.face ?? ((presentation.idleAllowed || dragging) ? poseId : null)
    : null;

  useEffect(() => watchReducedMotion(setReducedMotion), []);

  // The dot belongs to this avatar window. Settled outcomes fade, ongoing
  // ones stay visible; their pulse is a local CSS keyframe.
  const [dot, setDot] = useState<TaskDot | null>(null);
  const dotHold = useRef<number | null>(null);
  useEffect(() => {
    const next = taskDot(taskStatus);
    if (dotHold.current !== null) { window.clearTimeout(dotHold.current); dotHold.current = null; }
    if (!next || next.pulse) { setDot(next); return; }
    setDot(next);
    dotHold.current = window.setTimeout(() => { dotHold.current = null; setDot(null); }, TASK_DOT_HOLD_MS);
  }, [taskStatus]);
  useEffect(() => () => { if (dotHold.current !== null) window.clearTimeout(dotHold.current); }, []);

  // A sent message gets a brief acknowledgement. Repeated snapshots of the
  // same message do not restart the timer; changing tabs cancels it.
  const newestUserEntryId = snapshot ? lastUserEntryId(snapshot.timeline) : null;
  const lastUserRef = useRef<{ conversationId: string | undefined; entryId: string | null } | null>(null);
  useEffect(() => {
    const conversationId = snapshot?.conversationId;
    const previous = lastUserRef.current;
    lastUserRef.current = { conversationId, entryId: newestUserEntryId };
    if (!previous || previous.conversationId !== conversationId) {
      if (sendTimer.current !== null) window.clearTimeout(sendTimer.current);
      sendTimer.current = null;
      setAcknowledging(false);
      return;
    }
    if (newestUserEntryId === null || newestUserEntryId === previous.entryId) return;
    if (sendTimer.current !== null) window.clearTimeout(sendTimer.current);
    setAcknowledging(true);
    sendTimer.current = window.setTimeout(() => {
      sendTimer.current = null;
      setAcknowledging(false);
    }, SEND_FACE_HOLD_MS);
  }, [snapshot?.conversationId, newestUserEntryId]);

  // Show a finished/failed expression only on a transition in the current
  // conversation. An old completed tab must not smile again when selected.
  const outcomeRef = useRef<{ conversationId: string | undefined; kind: 'done' | 'failed' | null } | null>(null);
  useEffect(() => {
    const conversationId = snapshot?.conversationId;
    const kind = taskStatus === 'failed' || avatarState === 'error' ? 'failed'
      : taskStatus === 'done' || avatarState === 'success' ? 'done' : null;
    const previous = outcomeRef.current;
    outcomeRef.current = { conversationId, kind };
    if (previous && previous.conversationId === conversationId && previous.kind === kind) return;
    if (outcomeTimer.current !== null) window.clearTimeout(outcomeTimer.current);
    outcomeTimer.current = null;
    if (!previous || previous.conversationId !== conversationId || kind === null) {
      setSettled(null);
      return;
    }
    setSettled(kind);
    outcomeTimer.current = window.setTimeout(() => {
      outcomeTimer.current = null;
      setSettled(null);
    }, kind === 'done' ? FACE_HOLD_MS : FAILED_FACE_HOLD_MS);
  }, [snapshot?.conversationId, taskStatus, avatarState]);
  useEffect(() => () => {
    if (sendTimer.current !== null) window.clearTimeout(sendTimer.current);
    if (outcomeTimer.current !== null) window.clearTimeout(outcomeTimer.current);
    cancelPoseSwap(swapRef.current);
    cancelClickBounce(gestureRef.current);
    cancelAhogeFlick(ahogeRef.current);
  }, []);

  // Inactivity sleeps only the idle breath; task and voice state wake it.
  useEffect(() => {
    const REST_MS = 60_000;
    document.body.classList.remove('is-resting');
    if (!presentation.idleAllowed) return;
    let timer = window.setTimeout(() => document.body.classList.add('is-resting'), REST_MS);
    const wake = (): void => {
      document.body.classList.remove('is-resting');
      window.clearTimeout(timer);
      timer = window.setTimeout(() => document.body.classList.add('is-resting'), REST_MS);
    };
    const events = ['pointermove', 'pointerdown', 'wheel'] as const;
    for (const name of events) window.addEventListener(name, wake, { passive: true });
    return () => {
      window.clearTimeout(timer);
      for (const name of events) window.removeEventListener(name, wake);
    };
  }, [presentation.idleAllowed]);

  // 元素上的 pointerup 偶尔收不到（指针被别的窗口或系统手势抢走）：窗口级
  // 的抬起与取消兜底收尾，别让会话留在引用里把后续的拖动和单击一起挡掉。
  useEffect(() => {
    const settle = (): void => {
      if (!pointer.current) return;
      pointer.current = null;
      setDragging(false);
      queueDrag((bridge) => bridge.endDrag());
    };
    window.addEventListener('pointerup', settle);
    window.addEventListener('pointercancel', settle);
    return () => {
      window.removeEventListener('pointerup', settle);
      window.removeEventListener('pointercancel', settle);
    };
  }, []);

  useEffect(() => {
    if (!presentation.idleAllowed || reducedMotion) return;
    const stop = startIdleFidgets(idleRef.current, false);
    idleStop.current = stop;
    return () => {
      stop();
      if (idleStop.current === stop) idleStop.current = null;
    };
  }, [presentation.idleAllowed, reducedMotion, personaId, interactionEpoch]);
  useEffect(() => { if (personaArt.poses) preloadPoses(); }, [personaArt.poses]);
  useEffect(() => {
    if (dragging) return;
    if (!personaArt.poses || !presentation.idleAllowed || reducedMotion) {
      setPoseId(null);
      return;
    }
    setPoseId(null);
    return startPoseClock((pose) => setPoseId(pose?.id ?? null));
  }, [personaArt.poses, presentation.idleAllowed, reducedMotion, personaId, dragging]);

  // Expression changes use a small opacity dip, while dragging and reduced
  // motion update immediately. The swap controller cancels stale
  // onfinish callbacks, including fast task/voice/tab changes.
  useEffect(() => {
    if (reducedMotion || dragging) {
      cancelPoseSwap(swapRef.current);
      requestedArt.current = desiredArt;
      setVisibleArt(desiredArt);
      return;
    }
    if (requestedArt.current === desiredArt) return;
    requestedArt.current = desiredArt;
    playPoseSwap(swapRef.current, () => setVisibleArt(desiredArt), false);
  }, [desiredArt, reducedMotion, dragging]);

  useEffect(() => {
    if (reducedMotion || dragging) {
      cancelClickBounce(gestureRef.current);
      cancelAhogeFlick(ahogeRef.current);
    }
  }, [reducedMotion, dragging]);

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

  function pauseIdleForInteraction() {
    idleStop.current?.();
    idleStop.current = null;
    setInteractionEpoch((epoch) => epoch + 1);
  }

  function handlePointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    // 一次丢失的 pointerup（别的窗口抢走指针、系统手势插进来）会把会话留在
    // 引用里，之后的每一次按下都被它挡掉——拖动和单击一起失灵。超过两秒的
    // 旧会话一律当成丢事件清掉，然后照常开始这一次。
    if (pointer.current) {
      if (Date.now() - pointer.current.at < 2000) return;
      pointer.current = null;
      queueDrag((bridge) => bridge.endDrag());
    }
    event.preventDefault();
    pauseIdleForInteraction();
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    const position = { x: event.screenX, y: event.screenY };
    lastPointerPosition.current = position;
    lastMoveSent.current = null;
    pointer.current = {
      id: event.pointerId,
      screenX: event.screenX,
      screenY: event.screenY,
      moved: false,
      at: Date.now(),
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
    setDragging(false);
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
      playClickBounce(gestureRef.current, reducedMotion);
      playAhogeFlick(ahogeRef.current, reducedMotion);
      queueDrag((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
    }
  }

  return (
    <main className={`avatar-stage is-${presentation.activity}${panelOpen ? ' is-panel-open' : ''}`} onContextMenu={(event) => { void openContextMenu(event); }}>
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
            pauseIdleForInteraction();
            playClickBounce(gestureRef.current, reducedMotion);
            playAhogeFlick(ahogeRef.current, reducedMotion);
            void run((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
          }
        }}
      >
        <WhalePortrait gestureRef={gestureRef} idleRef={idleRef} swapRef={swapRef} ahogeRef={ahogeRef}
          artworkUrl={personaArt.poses && visibleArt ? poseSrc(visibleArt) : null}
          personaId={personaId}
          size={snapshot?.conversationLibrary?.settings.avatarSize ?? 'small'}
          onBoxChange={(box: AvatarBox) => { void petBridge().setAvatarBox(box).catch(() => undefined); }} />
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

/** 面板窗口：与头像分开的透明窗口，只渲染对话面板。窗口尺寸/位置由主进程
 *  控制，这里只管把快照接上。 */
function PanelWindow() {
  const { snapshot, error, run } = usePetState();
  return <PanelBubble visible snapshot={snapshot} error={error} run={run} />;
}

const query = new URLSearchParams(window.location.search);
const balanceOnly = query.get('balance') === '1';
const panelOnly = query.get('mode') === 'panel';
if (balanceOnly) document.body.classList.add('balance-window');
if (panelOnly) document.body.classList.add('panel-window');
createRoot(document.getElementById('root')!).render(panelOnly ? <PanelWindow /> : balanceOnly ? <BalanceOverlay /> : <Avatar />);
