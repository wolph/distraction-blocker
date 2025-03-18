import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import type { Ack } from '../shared/messages';
import { sendRequest } from '../shared/messages';
import {
  ackError,
  isListsConfig,
  isSessionSnapshot,
  isSettings,
} from '../shared/runtime-validation';
import type { ListsConfig, SessionSnapshot, Settings, ThemeMode } from '../shared/types';

const LOAD_ERROR: string = 'Could not load settings. Reload the page to try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SettingsStore {
  /** null until the initial load resolves */
  settings: Settings | null;
  lists: ListsConfig | null;
  snapshot: SessionSnapshot | null;
  loadError: string | null;
  /** resolves null on success, the worker's rejection string verbatim otherwise */
  saveSettings(next: Settings): Promise<string | null>;
  saveTheme(next: ThemeMode): Promise<string | null>;
  saveLists(next: ListsConfig): Promise<string | null>;
}

/**
 * Loads settings, lists, and the session snapshot once, keeps the snapshot
 * live via the stateChanged broadcast, and exposes save calls that only
 * update the store after the worker accepts the write.
 */
export function useSettingsStore(): SettingsStore {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  const [snapshot, setSnapshot]: [
    SessionSnapshot | null,
    Dispatch<StateUpdater<SessionSnapshot | null>>,
  ] = useState<SessionSnapshot | null>(null);
  const [loadError, setLoadError]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);

  useEffect((): (() => void) => {
    let alive: boolean = true;
    const load: () => Promise<void> = async (): Promise<void> => {
      try {
        const [loadedSettings, loadedLists, loadedSnapshot]: [unknown, unknown, unknown] =
          await Promise.all([
            sendRequest({ type: 'getSettings' }),
            sendRequest({ type: 'getLists' }),
            sendRequest({ type: 'getSnapshot' }),
          ]);
        if (!alive) return;
        if (
          !isSettings(loadedSettings) ||
          !isListsConfig(loadedLists) ||
          !isSessionSnapshot(loadedSnapshot)
        ) {
          setLoadError(LOAD_ERROR);
          return;
        }
        setSettings(loadedSettings);
        setLists(loadedLists);
        setSnapshot(loadedSnapshot);
        setLoadError(null);
      } catch {
        if (alive) setLoadError(LOAD_ERROR);
      }
    };
    void load();
    const onBroadcast: (message: unknown) => void = (message: unknown): void => {
      if (
        isRecord(message) &&
        message.type === 'stateChanged' &&
        isSessionSnapshot(message.snapshot)
      ) {
        setSnapshot(message.snapshot);
      }
    };
    chrome.runtime.onMessage.addListener(onBroadcast);
    return (): void => {
      alive = false;
      chrome.runtime.onMessage.removeListener(onBroadcast);
    };
  }, []);

  const saveSettings: (next: Settings) => Promise<string | null> = async (
    next: Settings,
  ): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateSettings', settings: next });
    const responseError: string | null = ackError(
      ack,
      'Could not save settings. Reload the page and try again.',
    );
    if (responseError !== null) return responseError;
    setSettings(next);
    return null;
  };

  const saveLists: (next: ListsConfig) => Promise<string | null> = async (
    next: ListsConfig,
  ): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateLists', lists: next });
    const responseError: string | null = ackError(
      ack,
      'Could not save lists. Reload the page and try again.',
    );
    if (responseError !== null) return responseError;
    setLists(next);
    return null;
  };

  const saveTheme: (next: ThemeMode) => Promise<string | null> = async (
    next: ThemeMode,
  ): Promise<string | null> => {
    const ack: Ack = await sendRequest({ type: 'updateTheme', theme: next });
    const responseError: string | null = ackError(
      ack,
      'Could not save theme. Reload the page and try again.',
    );
    if (responseError !== null) return responseError;
    setSettings((current: Settings | null): Settings | null =>
      current === null ? null : { ...current, theme: next },
    );
    return null;
  };

  return { settings, lists, snapshot, loadError, saveSettings, saveTheme, saveLists };
}
