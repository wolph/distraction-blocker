import { useEffect, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { type StatsBundle, sendRequest } from '../shared/messages';
import type { PauseEconomy, Settings } from '../shared/types';

/** One getStats request on mount feeds the whole page. */
export function useStats(): StatsBundle | null {
  const [bundle, setBundle] = useState<StatsBundle | null>(null);
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
export function useEconomy(): PauseEconomy {
  const [economy, setEconomy] = useState<PauseEconomy>(DEFAULT_SETTINGS.pause);
  useEffect((): void => {
    sendRequest({ type: 'getSettings' })
      .then((settings: Settings): void => setEconomy(settings.pause))
      .catch((err: unknown): void => {
        console.error('getSettings failed', err);
      });
  }, []);
  return economy;
}
