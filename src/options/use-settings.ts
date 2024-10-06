import { useEffect, useState } from 'preact/hooks';
import type { Ack, Broadcast } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import type { ListsConfig, SessionSnapshot, Settings } from '../shared/types';

export interface SettingsStore {
  /** null until the initial load resolves */
  settings: Settings | null;
  lists: ListsConfig | null;
  snapshot: SessionSnapshot | null;
  /** resolves null on success, the worker's rejection string verbatim otherwise */
  saveSettings(next: Settings): Promise<string | null>;
  saveLists(next: ListsConfig): Promise<string | null>;
}

/**
 * Loads settings, lists, and the session snapshot once, keeps the snapshot
 * live via the stateChanged broadcast, and exposes save calls that only
 * update the store after the worker accepts the write.
 */
export function useSettingsStore(): SettingsStore {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [lists, setLists] = useState<ListsConfig | null>(null);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);

  useEffect((): (() => void) => {
    let alive: boolean = true;
    const load = async (): Promise<void> => {
      const [loadedSettings, loadedLists, loadedSnapshot] = await Promise.all([
        sendRequest({ type: 'getSettings' }),
        sendRequest({ type: 'getLists' }),
        sendRequest({ type: 'getSnapshot' }),
      ]);
      if (!alive) return;
      setSettings(loadedSettings);
      setLists(loadedLists);
      setSnapshot(loadedSnapshot);
    };
    void load();
    const onBroadcast = (message: Broadcast): void => {
      if (message.type === 'stateChanged') setSnapshot(message.snapshot);
    };
    chrome.runtime.onMessage.addListener(onBroadcast);
    return (): void => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onBroadcast);
    };
  }, []);

  const saveSettings = async (next: Settings): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateSettings', settings: next });
    if (!ack.ok) return ack.error;
    setSettings(next);
    return null;
  };

  const saveLists = async (next: ListsConfig): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
    if (!ack.ok) return ack.error;
    setLists(next);
    return null;
  };

  return { settings, lists, snapshot, saveSettings, saveLists };
}
