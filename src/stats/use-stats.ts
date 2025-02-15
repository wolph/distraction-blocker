import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import type { EventRecord, PauseEconomy, Settings } from '../shared/types';

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
      .then((loaded: StatsBundle): void => {
        setBundle(loaded);
        setError(false);
      })
      .catch((): void => {
        setBundle(null);
        setError(true);
      });
  }, []);
  return { bundle, error };
}

function isEventRecord(value: unknown): value is EventRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  return typeof record.t === 'string' && typeof record.at === 'number';
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
      .then((response: { json: string }): void => {
        try {
          const parsed: unknown = JSON.parse(response.json);
          const records: EventRecord[] = Array.isArray(parsed) ? parsed.filter(isEventRecord) : [];
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
      .then((settings: Settings): void => {
        setEconomy(settings.pause);
        setError(false);
      })
      .catch((): void => {
        setEconomy(DEFAULT_SETTINGS.pause);
        setError(true);
      });
  }, []);
  return { economy, error };
}
