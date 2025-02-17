import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import type { EventRecord, PauseEconomy } from '../shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStatsBundle(value: unknown): value is StatsBundle {
  if (!isRecord(value)) return false;
  const totals: unknown = value.totals;
  return (
    Array.isArray(value.days) &&
    Array.isArray(value.months) &&
    Array.isArray(value.recentSessions) &&
    isRecord(value.streak) &&
    isRecord(totals) &&
    typeof totals.focusMsToday === 'number' &&
    typeof totals.focusMsWeek === 'number' &&
    typeof totals.attemptsToday === 'number' &&
    typeof totals.resistedToday === 'number'
  );
}

function isPauseEconomy(value: unknown): value is PauseEconomy {
  return (
    isRecord(value) &&
    typeof value.earnRatio === 'number' &&
    typeof value.capMs === 'number' &&
    typeof value.pauseMs === 'number' &&
    typeof value.unlockMs === 'number'
  );
}

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
      .then((response: unknown): void => {
        try {
          if (!isRecord(response) || typeof response.json !== 'string') {
            throw new TypeError('Invalid event export response');
          }
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
      .then((settings: unknown): void => {
        const pause: unknown = isRecord(settings) ? settings.pause : undefined;
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
