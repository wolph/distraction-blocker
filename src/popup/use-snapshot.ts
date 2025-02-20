import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { isSessionSnapshot } from '../shared/runtime-validation';
import type { SessionSnapshot } from '../shared/types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/**
 * Subscribe to the worker's session snapshot. The initial value comes from a
 * getSnapshot request, updates arrive as stateChanged broadcasts, and `now`
 * ticks every 250 ms so views can extrapolate with src/shared/live.ts.
 */
export function useSnapshot(): {
  snapshot: SessionSnapshot | null;
  now: number;
  error: boolean;
} {
  const [snapshot, setSnapshot]: [
    SessionSnapshot | null,
    Dispatch<StateUpdater<SessionSnapshot | null>>,
  ] = useState<SessionSnapshot | null>(null);
  const [now, setNow]: [number, Dispatch<StateUpdater<number>>] = useState<number>(Date.now());
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);

  useEffect((): (() => void) => {
    void sendRequest({ type: 'getSnapshot' })
      .then((value: unknown): void => {
        if (isSessionSnapshot(value)) {
          setSnapshot(value);
          setError(false);
          return;
        }
        setSnapshot(null);
        setError(true);
      })
      .catch((): void => {
        setSnapshot(null);
        setError(true);
      });
    const onMsg: (msg: unknown) => void = (msg: unknown): void => {
      if (!isRecord(msg) || msg.type !== 'stateChanged') return;
      if (isSessionSnapshot(msg.snapshot)) {
        setSnapshot(msg.snapshot);
        setError(false);
        return;
      }
      setSnapshot(null);
      setError(true);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => setNow(Date.now()), 250);
    return (): void => {
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(timer);
    };
  }, []);

  return { snapshot, now, error };
}
