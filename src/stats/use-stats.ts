import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import type { EventRecord, PauseEconomy, Settings } from '../shared/types';

/** One getStats request on mount feeds the whole page. */
export function useStats(): StatsBundle | null {
  const [bundle, setBundle]: [StatsBundle | null, Dispatch<StateUpdater<StatsBundle | null>>] =
    useState<StatsBundle | null>(null);
  useEffect((): void => {
    sendRequest({ type: 'getStats', days: 30 })
      .then((b: StatsBundle): void => setBundle(b))
      .catch((err: unknown): void => {
        console.error('getStats failed', err);
      });
  }, []);
  return bundle;
}

/**
 * The pause economy settings, for the spent-vs-earned tile. Falls back to the
 * defaults until the worker answers, which only skews the derived earned
 * figure when the user changed the earn ratio and the fetch fails.
 */
function isEventRecord(value: unknown): value is EventRecord {
  if (typeof value !== 'object' || value === null) return false;
  const rec: Record<string, unknown> = value as Record<string, unknown>;
  return typeof rec.t === 'string' && typeof rec.at === 'number';
}

/**
 * The local event log, for the attempts-by-hour chart. The export is this
 * machine only, which the chart captions honestly.
 */
export function useAttemptEvents(): EventRecord[] | null {
  const [events, setEvents]: [EventRecord[] | null, Dispatch<StateUpdater<EventRecord[] | null>>] =
    useState<EventRecord[] | null>(null);
  useEffect((): void => {
    sendRequest({ type: 'exportEvents' })
      .then((res: { json: string }): void => {
        try {
          const parsed: unknown = JSON.parse(res.json);
          const records: EventRecord[] = Array.isArray(parsed) ? parsed.filter(isEventRecord) : [];
          setEvents(records.filter((e: EventRecord): boolean => e.t === 'attempt'));
        } catch (err: unknown) {
          console.error('exportEvents returned unparseable JSON', err);
          setEvents([]);
        }
      })
      .catch((err: unknown): void => {
        console.error('exportEvents failed', err);
        setEvents([]);
      });
  }, []);
  return events;
}

export function useEconomy(): PauseEconomy {
  const [economy, setEconomy]: [PauseEconomy, Dispatch<StateUpdater<PauseEconomy>>] =
    useState<PauseEconomy>(DEFAULT_SETTINGS.pause);
  useEffect((): void => {
    sendRequest({ type: 'getSettings' })
      .then((settings: Settings): void => setEconomy(settings.pause))
      .catch((err: unknown): void => {
        console.error('getSettings failed', err);
      });
  }, []);
  return economy;
}
