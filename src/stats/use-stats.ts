import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import {
  isPauseEconomy,
  isSessionSnapshot,
  isSettings,
  isStatsBundle,
  parseEventExportResponse,
} from '../shared/runtime-validation';
import { updateTheme } from '../shared/theme';
import type { EventRecord, PauseEconomy, Settings, ThemeMode } from '../shared/types';

export interface StatsLoadState {
  bundle: StatsBundle | null;
  error: boolean;
}

/** One getStats request on mount feeds the whole page. */
export function useStats(): StatsLoadState {
  const [bundle, setBundle]: [StatsBundle | null, Dispatch<StateUpdater<StatsBundle | null>>] =
    useState<StatsBundle | null>(null);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): void => {
    sendRequest({ type: 'getStats', days: 30 })
      .then((loaded: unknown): void => {
        if (isStatsBundle(loaded)) {
          setBundle(loaded);
          setError(false);
        } else {
          setBundle(null);
          setError(true);
        }
      })
      .catch((): void => {
        setBundle(null);
        setError(true);
      });
  }, []);
  return { bundle, error };
}

export interface AttemptEventsState {
  events: EventRecord[] | null;
  error: boolean;
}

/** Local event log for the attempts-by-hour chart. */
export function useAttemptEvents(): AttemptEventsState {
  const [events, setEvents]: [EventRecord[] | null, Dispatch<StateUpdater<EventRecord[] | null>>] =
    useState<EventRecord[] | null>(null);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): void => {
    sendRequest({ type: 'exportEvents' })
      .then((response: unknown): void => {
        try {
          const records: EventRecord[] | null = parseEventExportResponse(response);
          if (records === null) throw new TypeError('Invalid event export response');
          setEvents(records.filter((event: EventRecord): boolean => event.t === 'attempt'));
          setError(false);
        } catch {
          setEvents([]);
          setError(true);
        }
      })
      .catch((): void => {
        setEvents([]);
        setError(true);
      });
  }, []);
  return { events, error };
}

export interface EconomyState {
  economy: PauseEconomy;
  theme: ThemeMode | null;
  error: boolean;
  saveTheme(next: ThemeMode): Promise<string | null>;
}

/** Pause settings for the spent-versus-earned tile. */
export function useEconomy(): EconomyState {
  const [economy, setEconomy]: [PauseEconomy, Dispatch<StateUpdater<PauseEconomy>>] =
    useState<PauseEconomy>(DEFAULT_SETTINGS.pause);
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): (() => void) => {
    let latestTheme: ThemeMode | null = null;
    void sendRequest({ type: 'getSettings' })
      .then((loaded: unknown): void => {
        if (isSettings(loaded) && isPauseEconomy(loaded.pause)) {
          setSettings({ ...loaded, theme: latestTheme ?? loaded.theme });
          setEconomy(loaded.pause);
          setError(false);
        } else {
          setSettings(null);
          setEconomy(DEFAULT_SETTINGS.pause);
          setError(true);
        }
      })
      .catch((): void => {
        setSettings(null);
        setEconomy(DEFAULT_SETTINGS.pause);
        setError(true);
      });

    const onBroadcast: (message: unknown) => void = (message: unknown): void => {
      if (
        typeof message === 'object' &&
        message !== null &&
        'type' in message &&
        message.type === 'stateChanged' &&
        'snapshot' in message &&
        isSessionSnapshot(message.snapshot)
      ) {
        const theme: ThemeMode = message.snapshot.theme;
        latestTheme = theme;
        setSettings((current: Settings | null): Settings | null =>
          current === null ? null : { ...current, theme },
        );
      }
    };
    chrome.runtime.onMessage?.addListener(onBroadcast);
    return (): void => chrome.runtime.onMessage?.removeListener(onBroadcast);
  }, []);

  const saveTheme: (next: ThemeMode) => Promise<string | null> = async (
    next: ThemeMode,
  ): Promise<string | null> => {
    const saveError: string | null = await updateTheme(next);
    if (saveError === null) {
      setSettings((current: Settings | null): Settings | null =>
        current === null ? null : { ...current, theme: next },
      );
    }
    return saveError;
  };

  return { economy, theme: settings?.theme ?? null, error, saveTheme };
}
