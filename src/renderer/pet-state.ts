import { useCallback, useEffect, useState } from 'react';
import type { AppSnapshot, PetAPI } from '../shared/contracts';

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

export function usePetState() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let receivedUpdate = false;
    let unsubscribe: (() => void) | undefined;

    try {
      const bridge = petBridge();
      unsubscribe = bridge.onSnapshot((next) => {
        if (active) {
          receivedUpdate = true;
          setSnapshot(next);
          setError(null);
        }
      });
      void bridge.getSnapshot().then((next) => {
        if (active && !receivedUpdate) setSnapshot(next);
      }).catch((cause: unknown) => {
        if (active) setError(errorText(cause));
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
