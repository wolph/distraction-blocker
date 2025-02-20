import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import {
  isPauseEconomy,
  isStatsBundle,
  parseEventExportResponse,
} from '../shared/runtime-validation';
import type { EventRecord, PauseEconomy } from '../shared/types';

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
  error: boolean;
}

/** Pause settings for the spent-versus-earned tile. */
export function useEconomy(): EconomyState {
  const [economy, setEconomy]: [PauseEconomy, Dispatch<StateUpdater<PauseEconomy>>] =
    useState<PauseEconomy>(DEFAULT_SETTINGS.pause);
  const [error, setError]: [boolean, Dispatch<StateUpdater<boolean>>] = useState<boolean>(false);
  useEffect((): void => {
    sendRequest({ type: 'getSettings' })
      .then((settings: unknown): void => {
        const pause: unknown =
          typeof settings === 'object' && settings !== null && 'pause' in settings
            ? settings.pause
            : undefined;
        if (isPauseEconomy(pause)) {
          setEconomy(pause);
          setError(false);
        } else {
          setEconomy(DEFAULT_SETTINGS.pause);
          setError(true);
        }
      })
      .catch((): void => {
        setEconomy(DEFAULT_SETTINGS.pause);
        setError(true);
      });
  }, []);
  return { economy, error };
}
