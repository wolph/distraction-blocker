import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { reloadOnceForInvalidSnapshot } from '../shared/reload-once';
import { isSessionSnapshot } from '../shared/runtime-validation';
import type { SessionSnapshot } from '../shared/types';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

/** The worker's refusal shape, which every request gets while the worker is stopped. */
function isRejection(value: unknown): boolean {
  return isRecord(value) && value.ok === false;
}

/**
 * Subscribe to the worker's session snapshot. The initial value comes from a
 * getSnapshot request, updates arrive as stateChanged broadcasts, and `now`
 * ticks every 250 ms so views can extrapolate with src/shared/live.ts.
 */
export function useSnapshot(refreshVersion: number = 0): {
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
    let receivedBroadcast: boolean = false;
    let disposed: boolean = false;
    void sendRequest({ type: 'getSnapshot' })
      .then((value: unknown): void => {
        if (disposed || receivedBroadcast) return;
        if (isSessionSnapshot(value)) {
          setSnapshot(value);
          setError(false);
          return;
        }
        // A worker that refused the request is not a stale page. The reload exists for a page
        // older than the worker, and it would only put the recovery screen behind a flash here.
        if (!isRejection(value) && reloadOnceForInvalidSnapshot()) return;
        setSnapshot(null);
        setError(true);
      })
      .catch((): void => {
        if (disposed || receivedBroadcast) return;
        setSnapshot(null);
        setError(true);
      });
    const onMsg: (msg: unknown) => void = (msg: unknown): void => {
      if (!isRecord(msg) || msg.type !== 'stateChanged') return;
      receivedBroadcast = true;
      if (isSessionSnapshot(msg.snapshot)) {
        setSnapshot(msg.snapshot);
        setError(false);
        return;
      }
      if (reloadOnceForInvalidSnapshot()) return;
      setSnapshot(null);
      setError(true);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => setNow(Date.now()), 250);
    return (): void => {
      disposed = true;
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(timer);
    };
  }, [refreshVersion]);

  return { snapshot, now, error };
}
