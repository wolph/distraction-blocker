import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { sendRequest } from '../shared/messages';
import { isDeviceId, parseEventExportResponse } from '../shared/runtime-validation';
import { LOCAL_DEVICE_ID } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';

/** Export of the local event log plus the device id behind cross-device stats. */
export function Data(): VNode {
  const [deviceId, setDeviceId]: [string, Dispatch<StateUpdater<string>>] = useState<string>('');
  const [deviceLoading, setDeviceLoading]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(true);
  const [deviceError, setDeviceError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const [exportError, setExportError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);

  useEffect((): (() => void) => {
    let alive: boolean = true;
    const load: () => Promise<void> = async (): Promise<void> => {
      try {
        const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DEVICE_ID);
        const id: unknown = stored[LOCAL_DEVICE_ID];
        if (!isDeviceId(id)) throw new TypeError('Invalid device id');
        if (alive) {
          setDeviceId(id);
          setDeviceError(null);
        }
      } catch {
        if (alive) {
          setDeviceId('');
          setDeviceError('Could not load this device id. Reload the page to try again.');
        }
      } finally {
        if (alive) setDeviceLoading(false);
      }
    };
    void load();
    return (): void => {
      alive = false;
    };
  }, []);

  const exportEvents: () => Promise<void> = async (): Promise<void> => {
    setExportError(null);
    try {
      const response: unknown = await sendRequest({ type: 'exportEvents' });
      if (parseEventExportResponse(response) === null) throw new Error('invalid export response');
      const exportResponse: { json: string } = response as { json: string };
      const blob: Blob = new Blob([exportResponse.json], { type: 'application/json' });
      const url: string = URL.createObjectURL(blob);
      const anchor: HTMLAnchorElement = document.createElement('a');
      anchor.href = url;
      anchor.download = `focus-lock-events-${localDateStr(Date.now())}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch {
      setExportError('Could not export the event log. Try again.');
    }
  };

  return (
    <div>
      <h3>Event log</h3>
      <p class="help">
        Every session, blocked attempt, and gate outcome on this machine, as JSON. The log stays
        local and never syncs.
      </p>
      <div class="save-row">
        <button
          type="button"
          class="secondary"
          onClick={(): void => {
            void exportEvents();
          }}
        >
          Export event log
        </button>
        {exportError !== null ? (
          <p class="save-error" role="alert">
            {exportError}
          </p>
        ) : null}
      </div>
      <h3>This device</h3>
      <p class="help">
        Aggregate stats merge across your Chrome instances through Chrome sync. This id keys this
        machine's share of them.
      </p>
      {deviceLoading ? (
        <p class="mono">Loading device id.</p>
      ) : deviceError !== null ? (
        <p class="save-error" role="alert">
          {deviceError}
        </p>
      ) : (
        <p class="mono">{deviceId}</p>
      )}
    </div>
  );
}
