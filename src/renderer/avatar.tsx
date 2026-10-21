import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { AvatarBox, BalanceSnapshot, PanelDirection, PanelPlacement, PetAPI } from '../shared/contracts';
import { WhalePortrait } from './WhalePortrait';
import { Live2DPortrait } from './Live2DPortrait';
import { live2dManifestForBinding } from './live2d-manifest';
import { personaVisualModeForRenderer, resolvePersonaVisualSelection } from './persona-visual-binding';
import { avatarArtFor } from './avatar-art';
import { avatarDisplaySize } from './avatar-geometry';
import { AvatarStateEffects } from './AvatarStateEffects';
import { avatarFaceUrl, avatarRigFor } from './avatar-rig';
import { faceForAvatarEmotion, resolveAvatarLanes } from './avatar-lanes';
import { cancelAvatarStateEntry, entryCueFor, playAvatarStateEntry } from './avatar-state-motion';
import { BalanceCard } from './balance';
import { balanceErrorMessage } from './balance-error';
import { PanelBubble } from './panel';
import { petBridge, usePetState } from './pet-state';
import { cancelClickBounce, playClickBounce, prefersReducedMotion, watchReducedMotion } from './avatar-motion';
import { playIdleFidget } from './avatar-idle';
import { startAvatarBehaviorScheduler, type AvatarBehaviorActions } from './avatar-behavior';
import { cancelPoseSwap, nextPose, playPoseSwap, preloadPoses } from './avatar-poses';
import { FACE_HOLD_MS, FAILED_FACE_HOLD_MS, lastUserEntryId, resolveAvatarPresentation, SEND_FACE_HOLD_MS, taskDot } from './avatar-face';
import { orderConversationTabs } from './panel-tabs';
import { cancelAhogeFlick, playAhogeFlick } from './avatar-ahoge';
import './avatar.css';

/** 右上角圆角弧：固定五个槽位，半径 50，从正上方顺时针转 4° 起，每 12° 一个点。
 *  对话不足五个时，空槽画空心点，位置不随对话数变化。 */
const STATUS_ARC_RADIUS = 50;
const STATUS_ARC_STEP_DEG = 12;
const STATUS_ARC_START_DEG = -78;
const STATUS_ARC_CENTER_LIFT = 3;
const STATUS_ARC_SLOTS = 5;

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

function sameAvatarBox(a: AvatarBox | null, b: AvatarBox): boolean {
  return Boolean(a && Math.abs(a.x - b.x) < .5 && Math.abs(a.y - b.y) < .5 &&
    Math.abs(a.width - b.width) < .5 && Math.abs(a.height - b.height) < .5);
}

function Avatar() {
  const { snapshot, error, run } = usePetState();
  const [approval, setApproval] = useState<{ id: string; title: string; detail?: string } | null>(null);
  useEffect(() => petBridge().onApprovalRequest((request) => setApproval(request)), []);
  const personaId = snapshot?.conversationLibrary?.settings.personaId ?? 'xiaojing';
  const personaArt = avatarArtFor(personaId);
  const personaRig = avatarRigFor(personaId);
  const avatarSize = snapshot?.conversationLibrary?.settings.avatarSize ?? 'small';
  const avatarRenderer = snapshot?.conversationLibrary?.settings.avatarRenderer ?? 'sprite';
  const visualSelection = resolvePersonaVisualSelection(personaId, personaVisualModeForRenderer(avatarRenderer));
  const live2dManifest = live2dManifestForBinding(visualSelection.live2d);
  const [live2dFailed, setLive2dFailed] = useState(false);
  const [live2dReady, setLive2dReady] = useState(false);
  // Live2D is a technical preview: the sprite portrait stays the default and
  // remains visible until the model is ready, or when the model/Core fails.
  const live2dRequested = live2dManifest !== null && !live2dFailed;
  const useLive2D = live2dRequested && live2dReady;
  useEffect(() => {
    setLive2dFailed(false);
    setLive2dReady(false);
  }, [live2dManifest]);
  const [panelOpen, setPanelOpen] = useState(false);
  const pointer = useRef<PointerSession | null>(null);
  const lastPointerPosition = useRef({ x: 0, y: 0 });
  const lastMoveSent = useRef<{ x: number; y: number } | null>(null);
  const dragQueue = useRef<Promise<void>>(Promise.resolve());
  const moveFrame = useRef<number | null>(null);
  const moveQueued = useRef(false);
  const moveDirty = useRef(false);
  const hitTargetRef = useRef<HTMLButtonElement | null>(null);
  const live2dBox = useRef<AvatarBox | null>(null);
  const gestureRef = useRef<HTMLDivElement | null>(null);
  const entryRef = useRef<HTMLDivElement | null>(null);
  const idleRef = useRef<HTMLDivElement | null>(null);
  const swapRef = useRef<HTMLDivElement | null>(null);
  const idleStop = useRef<(() => void) | null>(null);
  const ahogeRef = useRef<HTMLImageElement | null>(null);
  const [poseId, setPoseId] = useState<string | null>(null);
  const lastPose = useRef<string | null>(null);
  const greeted = useRef(false);
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
  const lanes = resolveAvatarLanes({ snapshot, acknowledging, settled, dragging, panelOpen });
  // The new lanes are the source of truth for whether an idle-only action may
  // take ownership. `presentation.idleAllowed` predates parked decisions and
  // compacting, so using it here could let a fidget interrupt those states.
  const idleBehaviorAllowed = lanes.task === 'idle' && lanes.voice === 'silent' && lanes.interaction === 'none';
  const stateFace = faceForAvatarEmotion(lanes.emotion);
  const desiredFace = stateFace ?? (idleBehaviorAllowed ? poseId : null);
  const desiredArt = avatarFaceUrl(personaId, desiredFace);
  const entryCue = entryCueFor(lanes);

  // Cubism does not expose a trimmed PNG rectangle. Reserve a square slot
  // using the same long-edge setting as the sprite renderer, then report the
  // immutable button geometry through the existing hit-shape IPC path.
  useEffect(() => {
    if (!useLive2D) {
      live2dBox.current = null;
      return;
    }
    const display = avatarDisplaySize(1, 1, avatarSize);
    document.documentElement.style.setProperty('--avatar-w', `${display.width.toFixed(2)}px`);
    document.documentElement.style.setProperty('--avatar-h', `${display.height.toFixed(2)}px`);
    const sync = (): void => {
      const rect = hitTargetRef.current?.getBoundingClientRect();
      if (!rect) return;
      const next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      if (sameAvatarBox(live2dBox.current, next)) return;
      live2dBox.current = next;
      try {
        void petBridge().setAvatarBox(next).catch(() => undefined);
      } catch {
        // A test renderer without the Electron bridge has no pointer shape.
      }
    };
    const frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sync) : undefined;
    window.addEventListener('resize', sync);
    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      window.removeEventListener('resize', sync);
    };
  }, [useLive2D, avatarSize]);

  useEffect(() => watchReducedMotion(setReducedMotion), []);

  // One dot per conversation, in the same order as the chat's top tabs.
  // The current conversation is the slightly larger one. Finished dots are
  // news, not a permanent state: green/red survives only until that
  // conversation has been opened, after which it falls back to idle grey.
  const statusConversations = orderConversationTabs(
    (snapshot?.conversationLibrary?.conversations ?? []).filter((item) => !item.archivedAt),
    snapshot?.conversationLibrary?.settings.tabOrder ?? []
  );
  const currentConversationId = snapshot?.conversationLibrary?.activeConversationId ?? snapshot?.conversationId;
  const [unseenFinished, setUnseenFinished] = useState<ReadonlySet<string>>(() => new Set());
  const previousStatuses = useRef(new Map<string, string>());
  useEffect(() => {
    const previous = previousStatuses.current;
    const next = new Map<string, string>();
    for (const item of statusConversations) next.set(item.id, item.taskStatus);
    previousStatuses.current = next;
    setUnseenFinished((current) => {
      const updated = new Set(current);
      let changed = false;
      for (const item of statusConversations) {
        const before = previous.get(item.id);
        const finished = item.taskStatus === 'done' || item.taskStatus === 'failed';
        // A transition into done/failed while the owner is elsewhere is
        // exactly the case worth a green/red dot.
        if (finished && before !== undefined && before !== item.taskStatus && item.id !== currentConversationId) {
          if (!updated.has(item.id)) { updated.add(item.id); changed = true; }
        }
        // Opening the conversation consumes its finished dot; starting a new
        // turn clears it too.
        if (item.id === currentConversationId && updated.delete(item.id)) changed = true;
        if (!finished && updated.delete(item.id)) changed = true;
      }
      for (const id of [...updated]) {
        if (!next.has(id)) { updated.delete(id); changed = true; }
      }
      return changed ? updated : current;
    });
  }, [statusConversations, currentConversationId]);

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
    cancelAvatarStateEntry(entryRef.current);
    cancelAhogeFlick(ahogeRef.current);
  }, []);

  // Inactivity sleeps only the idle breath; task and voice state wake it.
  useEffect(() => {
    const REST_MS = 60_000;
    document.body.classList.remove('is-resting');
    if (!idleBehaviorAllowed) return;
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
  }, [idleBehaviorAllowed]);

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

  // One clock owns every idle behaviour: fidgets and expression changes no
  // longer run separate timers that can fire into each other. The scheduler
  // stops the active action before it runs the next one, and its cleanup is
  // the same cleanup that restores the base portrait.
  useEffect(() => {
    if (!idleBehaviorAllowed || reducedMotion || useLive2D) return;
    const quiet = (): boolean =>
      !document.hidden && !document.body.classList.contains('is-resting') && !prefersReducedMotion();
    const actions: AvatarBehaviorActions = {
      fidget: () => quiet() ? playIdleFidget(idleRef.current) : undefined,
      ...(personaArt.poses ? {
        expression: () => {
          if (!quiet()) return undefined;
          const next = nextPose(lastPose.current);
          lastPose.current = next.id;
          setPoseId(next.id);
          return () => setPoseId(null);
        }
      } : {})
    };
    const stop = startAvatarBehaviorScheduler({ personaId, actions, onError: () => undefined });
    idleStop.current = stop;
    return () => {
      stop();
      if (idleStop.current === stop) idleStop.current = null;
    };
  }, [idleBehaviorAllowed, reducedMotion, personaId, interactionEpoch, personaArt.poses, useLive2D]);
  useEffect(() => { if (personaArt.poses) preloadPoses(); }, [personaArt.poses]);

  // 退出重启前做一个告别表情；先停掉空闲表情时钟，免得随机表情盖掉它。
  useEffect(() => petBridge().onFarewell?.(() => {
    idleStop.current?.();
    idleStop.current = null;
    setPoseId('sleepy');
  }), []);

  // 启动时先笑一下，再把表情交还给空闲时钟。只有带表情组的人设才有这一步。
  useEffect(() => {
    if (greeted.current || !personaArt.poses) return;
    greeted.current = true;
    const show = window.setTimeout(() => setPoseId('smile'), 450);
    const hide = window.setTimeout(() => setPoseId((current) => current === 'smile' ? null : current), 2000);
    return () => {
      window.clearTimeout(show);
      window.clearTimeout(hide);
    };
  }, [personaArt.poses]);

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

  const previousEntry = useRef<{ cue: string; personaId: string } | null>(null);
  useEffect(() => {
    const previous = previousEntry.current;
    previousEntry.current = { cue: entryCue, personaId };
    if (!previous || (previous.cue === entryCue && previous.personaId === personaId)) return;
    playAvatarStateEntry(entryRef.current, entryCue, personaId, reducedMotion);
  }, [entryCue, personaId, reducedMotion]);

  useEffect(() => {
    if (reducedMotion || dragging) {
      cancelClickBounce(gestureRef.current);
      cancelAhogeFlick(ahogeRef.current);
      cancelAvatarStateEntry(entryRef.current);
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
      // the feedback wait behind the drag chain. Live2D owns its own motion;
      // adding the CSS bounce here would double the movement.
      if (!useLive2D) {
        playClickBounce(gestureRef.current, reducedMotion);
        playAhogeFlick(ahogeRef.current, reducedMotion);
      }
      queueDrag((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
    }
  }

  // 7px 在 125% 缩放下是 8.75 个设备像素：圆边被抗锯齿抹成不圆的边，3px
  // 间距也会在 3/4 个设备像素之间跳。按设备像素取整后，点和间距始终是整数，
  // 任何缩放比例下都等距、都是正圆。
  const dotDpr = typeof window === 'undefined' ? 1 : (window.devicePixelRatio || 1);
  const snapDot = (value: number): number => Math.round(value * dotDpr) / dotDpr;
  return (
    <main
      className={`avatar-stage is-${presentation.activity}${panelOpen ? ' is-panel-open' : ''}`}
      data-persona={personaId}
      data-task={lanes.task}
      data-voice={lanes.voice}
      data-interaction={lanes.interaction}
      data-emotion={lanes.emotion}
      style={{
        '--avatar-accent': personaRig.motion.accent,
        '--avatar-dot-x': `${personaRig.motion.statusAnchor.x * 100}%`,
        '--avatar-dot-y': `${personaRig.motion.statusAnchor.y * 100}%`,
        '--avatar-dot-size': `${snapDot(7)}px`,
        '--avatar-face-x': `${personaRig.motion.faceAnchor.x * 100}%`,
        '--avatar-face-y': `${personaRig.motion.faceAnchor.y * 100}%`
      } as CSSProperties}
      onContextMenu={(event) => { void openContextMenu(event); }}>
      <button
        ref={hitTargetRef}
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
            if (!useLive2D) {
              playClickBounce(gestureRef.current, reducedMotion);
              playAhogeFlick(ahogeRef.current, reducedMotion);
            }
            void run((bridge) => panelOpen ? bridge.hidePanel() : bridge.showPanel());
          }
        }}
      >
        {live2dRequested && <div className="avatar-gesture">
              <Live2DPortrait manifest={live2dManifest} lanes={lanes}
                reducedMotion={reducedMotion}
                onReady={() => setLive2dReady(true)}
                onError={() => {
                  setLive2dReady(false)
                  setLive2dFailed(true)
                }} />
            </div>}
        {!useLive2D && <WhalePortrait gestureRef={gestureRef} entryRef={entryRef} idleRef={idleRef} swapRef={swapRef} ahogeRef={ahogeRef}
              artworkUrl={visibleArt}
              personaId={personaId}
              size={avatarSize}
              onBoxChange={(box: AvatarBox) => { void petBridge().setAvatarBox(box).catch(() => undefined); }} />}
        {!useLive2D && <AvatarStateEffects />}
      </button>
      {/* 状态条必须是舞台的直接子元素。放进按钮里会相对按钮（人物大小）
          定位，点会落到头发中间，而不是窗口右上角。 */}
      {statusConversations.length > 0 && <span className="avatar-status-strip" aria-hidden="true">
        <span className="avatar-status-dots">
          {Array.from({ length: STATUS_ARC_SLOTS }, (_, index) => {
            // 半径固定在 50：第一个点在上方，之后沿转角弧往右下排。
            const angle = (STATUS_ARC_START_DEG + STATUS_ARC_STEP_DEG * index) * Math.PI / 180;
            const arcRight = STATUS_ARC_RADIUS - STATUS_ARC_RADIUS * Math.cos(angle);
            const arcTop = STATUS_ARC_RADIUS + STATUS_ARC_RADIUS * Math.sin(angle) - STATUS_ARC_CENTER_LIFT;
            const style = {
              '--avatar-dot-right': `${arcRight.toFixed(2)}px`,
              '--avatar-dot-top': `${arcTop.toFixed(2)}px`
            } as CSSProperties;
            const item = statusConversations[index];
            // 空槽：五个位置始终占满，对话不足五个时用空心点补齐。
            if (!item) return <i key={`empty-${index}`} className="avatar-status-dot is-empty" style={style} />;
            // 完成/失败/取消都保留颜色；未读只影响是否闪，不再把绿/红藏成蓝色。
            const unread = unseenFinished.has(item.id);
            const state = item.taskStatus === 'cancelled'
              ? { tone: 'cancelled', pulse: false }
              : item.taskStatus === 'done'
                ? { tone: 'done', pulse: unread }
                : item.taskStatus === 'failed'
                  ? { tone: 'failed', pulse: unread }
                  : taskDot(item.taskStatus);
            return <i key={item.id}
              className={`avatar-status-dot${state ? ` is-${state.tone}` : ''}${state?.pulse ? ' is-pulsing' : ''}${item.id === currentConversationId ? ' is-current' : ''}`}
              style={style} />;
          })}
        </span>
      </span>}
      {approval && <div className="avatar-approval" role="dialog" aria-label={approval.title}>
        <div className="avatar-approval-copy">
          <strong>{approval.title}</strong>
          {approval.detail && <span>{approval.detail}</span>}
        </div>
        <div className="avatar-approval-actions">
          <button type="button" className="avatar-approval-yes" aria-label="批准" title="批准"
            onClick={() => { petBridge().answerApproval(approval.id, true); setApproval(null); }}>✓</button>
          <button type="button" className="avatar-approval-no" aria-label="拒绝" title="拒绝"
            onClick={() => { petBridge().answerApproval(approval.id, false); setApproval(null); }}>✕</button>
        </div>
      </div>}
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
  const [direction, setDirection] = useState<PanelDirection>('up');
  const [placement, setPlacement] = useState<PanelPlacement>('top');
  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    let unsubscribePlacement: (() => void) | undefined;
    try {
      const bridge = petBridge();
      unsubscribe = bridge.onPanelDirection((next) => { if (active) setDirection(next); });
      void bridge.getPanelDirection().then((next) => { if (active) setDirection(next); }).catch(() => undefined);
      unsubscribePlacement = bridge.onPanelPlacement((next) => { if (active) setPlacement(next); });
      void bridge.getPanelPlacement().then((next) => { if (active) setPlacement(next); }).catch(() => undefined);
    } catch {
      // 浏览器预览没有桌面桥接，保持向上即可。
    }
    return () => { active = false; unsubscribe?.(); unsubscribePlacement?.(); };
  }, []);
  return <PanelBubble visible snapshot={snapshot} error={error} run={run} direction={direction} placement={placement} />;
}

const query = new URLSearchParams(window.location.search);
const balanceOnly = query.get('balance') === '1';
const panelOnly = query.get('mode') === 'panel';
if (balanceOnly) document.body.classList.add('balance-window');
if (panelOnly) document.body.classList.add('panel-window');
createRoot(document.getElementById('root')!).render(panelOnly ? <PanelWindow /> : balanceOnly ? <BalanceOverlay /> : <Avatar />);
