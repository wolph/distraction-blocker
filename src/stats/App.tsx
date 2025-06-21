import type { JSX } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { type StatsBundle, sendRequest } from '../shared/messages';
import { isSetupState } from '../shared/runtime-validation';
import { SettingsNav } from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { EventRecord, PauseEconomy, SetupState, StorageMode } from '../shared/types';
import { Charts } from './Charts';
import { SessionLog } from './SessionLog';
import { Streak } from './Streak';
import { Tiles } from './Tiles';
import {
  type AttemptEventsState,
  type EconomyState,
  type StatsLoadState,
  useAttemptEvents,
  useEconomy,
  useStats,
} from './use-stats';

function partialLoadError(attempts: boolean, economy: boolean): string | null {
  if (attempts && economy) return 'Hourly attempts and pause settings are unavailable.';
  if (attempts) return 'Hourly attempts are unavailable.';
  if (economy) return 'Pause settings are unavailable.';
  return null;
}

function useSetupStorageMode(): StorageMode | null {
  const [storageMode, setStorageMode]: [
    StorageMode | null,
    Dispatch<StateUpdater<StorageMode | null>>,
  ] = useState<StorageMode | null>(null);
  useEffect((): (() => void) => {
    let active: boolean = true;
    void sendRequest({ type: 'getSetupState' })
      .then((setup: SetupState): void => {
        if (active && isSetupState(setup) && setup.completed && setup.storageMode !== null) {
          setStorageMode(setup.storageMode);
        }
      })
      .catch((): void => {});
    return (): void => {
      active = false;
    };
  }, []);
  return storageMode;
}

function pageScope(storageMode: StorageMode): string {
  return storageMode === 'sync'
    ? 'Synced totals from this Chrome account. Local-only panels are labeled.'
    : 'Totals from this machine. Focus Lock statistics are not synced.';
}

export function App(): JSX.Element {
  const stats: StatsLoadState = useStats();
  const economyState: EconomyState = useEconomy();
  const attempts: AttemptEventsState = useAttemptEvents();
  const bundle: StatsBundle | null = stats.bundle;
  const economy: PauseEconomy = economyState.economy;
  const events: EventRecord[] | null = attempts.events;
  const partialError: string | null = partialLoadError(attempts.error, economyState.error);
  const storageMode: StorageMode | null = useSetupStorageMode();
  const now: number = Date.now();

  useEffect((): void => {
    if (economyState.theme !== null) applyTheme(document.documentElement, economyState.theme);
  }, [economyState.theme]);

  return (
    <div class="stats-shell">
      <SettingsNav page="stats" theme={economyState.theme} onThemeChange={economyState.saveTheme} />
      <main class="stats-page">
        <header class="page-header">
          <h1>Your focus record</h1>
          {storageMode === null ? null : <p class="page-scope">{pageScope(storageMode)}</p>}
        </header>
        {stats.error ? (
          <p class="empty-line" role="alert">
            Could not load stats. Reload to try again.
          </p>
        ) : bundle === null ? (
          <p class="empty-line">Loading your stats.</p>
        ) : (
          <>
            {partialError === null ? null : (
              <p class="empty-line" role="alert">
                {partialError}
              </p>
            )}
            <Tiles bundle={bundle} economy={economy} now={now} />
            <Streak streak={bundle.streak} now={now} />
            <Charts bundle={bundle} events={events} now={now} />
            <SessionLog events={bundle.recentSessions} />
          </>
        )}
      </main>
    </div>
  );
}
