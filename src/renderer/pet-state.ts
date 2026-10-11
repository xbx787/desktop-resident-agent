import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSnapshot, PetAPI, TimelineEntry } from '../shared/contracts';

export function petBridge(): PetAPI {
  const bridge = window.pet;
  if (!bridge) {
    throw new Error('桌面桥接尚未就绪，请从桌面应用启动。');
  }
  return bridge;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Upserts a partial timeline — only the entries changed since the renderer's
 * last applied revision — onto the cached copy. Entries arrive in change
 * order and the timeline only ever grows at its tail, so unknown ids append
 * in the order given; entries that did not change keep their identity, which
 * is what lets every memoized row in the panel skip re-rendering.
 */
export function applyTimelineDelta(previous: TimelineEntry[], changes: TimelineEntry[]): TimelineEntry[] {
  if (!changes.length) return previous;
  const indexById = new Map(previous.map((entry, index) => [entry.id, index]));
  const next = previous.slice();
  for (const entry of changes) {
    const index = indexById.get(entry.id);
    if (index === undefined) {
      indexById.set(entry.id, next.length);
      next.push(entry);
    } else {
      next[index] = entry;
    }
  }
  return next;
}

export function usePetState() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The timeline revision this window has applied; -1 = nothing yet. Every
  // snapshot carries the authoritative value, so desync is detectable.
  const revisionRef = useRef(-1);
  const conversationRef = useRef<string | null>(null);
  const resyncingRef = useRef(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;

    try {
      const bridge = petBridge();
      // Pulls the full history and adopts it; also the recovery path when a
      // partial snapshot arrives without a base to apply it to (fresh window,
      // or a delta that was somehow missed).
      const resync = () => {
        if (resyncingRef.current) return;
        resyncingRef.current = true;
        void bridge.getSnapshot().then((full) => {
          if (!active) return;
          const switched = full.conversationId !== conversationRef.current;
          if (!switched && full.timelineRevision < revisionRef.current) return;
          conversationRef.current = full.conversationId ?? null;
          revisionRef.current = full.timelineRevision;
          setSnapshot(full);
        }).catch((cause: unknown) => {
          if (active) setError(errorText(cause));
        }).finally(() => {
          resyncingRef.current = false;
        });
      };
      unsubscribe = bridge.onSnapshot((incoming) => {
        if (!active) return;
        setError(null);
        // A different conversation: adopt it whole and restart the revision
        // bookkeeping — the controller always sends these in full.
        if (incoming.conversationId !== conversationRef.current) {
          conversationRef.current = incoming.conversationId ?? null;
          revisionRef.current = incoming.timelineRevision;
          setSnapshot(incoming);
          return;
        }
        if (incoming.timelinePartial) {
          // A full pull is in flight and will carry these changes; applying
          // them on top of a stale base would corrupt the row order.
          if (resyncingRef.current) return;
          if (revisionRef.current < 0) {
            resync();
            return;
          }
          if (incoming.timelineRevision < revisionRef.current) return;
          if (incoming.timelineRevision === revisionRef.current) {
            // No timeline changes this round; the rest of the snapshot still applies.
            setSnapshot((previous) => previous ? { ...incoming, timeline: previous.timeline } : previous);
            return;
          }
          revisionRef.current = incoming.timelineRevision;
          setSnapshot((previous) => previous
            ? { ...incoming, timeline: applyTimelineDelta(previous.timeline, incoming.timeline) }
            : previous);
          return;
        }
        revisionRef.current = incoming.timelineRevision;
        setSnapshot(incoming);
      });
      // First mount: the panel still needs a snapshot even while idle (no
      // publishes are flowing). Yields to anything that already arrived.
      void bridge.getSnapshot().then((next) => {
        if (active && revisionRef.current < 0) {
          conversationRef.current = next.conversationId ?? null;
          revisionRef.current = next.timelineRevision;
          setSnapshot(next);
        }
      }).catch((cause: unknown) => {
        if (active && revisionRef.current < 0) setError(errorText(cause));
      });
    } catch (cause) {
      setError(errorText(cause));
    }

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const run = useCallback(async (action: (bridge: PetAPI) => Promise<void>) => {
    setError(null);
    try {
      await action(petBridge());
      return true;
    } catch (cause) {
      setError(errorText(cause));
      return false;
    }
  }, []);

  return { snapshot, error, setError, run };
}
