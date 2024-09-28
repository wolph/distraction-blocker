import { useEffect, useState } from 'preact/hooks';
import type { Broadcast } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import type { SessionSnapshot } from '../shared/types';

/**
 * Subscribe to the worker's session snapshot. The initial value comes from a
 * getSnapshot request, updates arrive as stateChanged broadcasts, and `now`
 * ticks every 250 ms so views can extrapolate with src/shared/live.ts.
 */
export function useSnapshot(): { snapshot: SessionSnapshot | null; now: number } {
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const [now, setNow] = useState<number>(Date.now());

  useEffect((): (() => void) => {
    void sendRequest({ type: 'getSnapshot' }).then(setSnapshot);
    const onMsg = (msg: Broadcast): void => {
      if (msg.type === 'stateChanged') setSnapshot(msg.snapshot);
    };
    chrome.runtime.onMessage.addListener(onMsg);
    const timer: ReturnType<typeof setInterval> = setInterval((): void => setNow(Date.now()), 250);
    return (): void => {
      chrome.runtime.onMessage.removeListener(onMsg);
      clearInterval(timer);
    };
  }, []);

  return { snapshot, now };
}
