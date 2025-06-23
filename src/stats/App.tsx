import type { JSX } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { type StatsBundle, sendRequest } from '../shared/messages';
import { isSetupState } from '../shared/runtime-validation';
import { SettingsNav } from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { EventRecord, PauseEconomy, StorageMode } from '../shared/types';
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

type ScopeLoadState =
  | { status: 'loading'; storageMode: null }
  | { status: 'error'; storageMode: null }
  | { status: 'ready'; storageMode: StorageMode };

interface SetupScopeState {
  load: ScopeLoadState;
  retry(): void;
}

function useSetupScope(): SetupScopeState {
  const [load, setLoad]: [ScopeLoadState, Dispatch<StateUpdater<ScopeLoadState>>] =
    useState<ScopeLoadState>({ status: 'loading', storageMode: null });
  const [attempt, setAttempt]: [number, Dispatch<StateUpdater<number>>] = useState<number>(0);
  useEffect((): (() => void) => {
    let active: boolean = true;
    void sendRequest({ type: 'getSetupState' })
      .then((setup: unknown): void => {
        if (!active) return;
        if (isSetupState(setup) && setup.completed && setup.storageMode !== null) {
          setLoad({ status: 'ready', storageMode: setup.storageMode });
        } else {
          setLoad({ status: 'error', storageMode: null });
        }
      })
      .catch((): void => {
        if (active) setLoad({ status: 'error', storageMode: null });
      });
    return (): void => {
      active = false;
    };
  }, [attempt]);
  return {
    load,
    retry: (): void => {
      setLoad({ status: 'loading', storageMode: null });
      setAttempt((current: number): number => current + 1);
    },
  };
}

function pageScope(storageMode: StorageMode): string {
  return storageMode === 'sync'
    ? 'Synced totals from this Chrome account. Local-only panels are labeled.'
    : 'Totals from this machine. Focus Lock statistics are not synced.';
}

function ScopeDisclosure(props: SetupScopeState): JSX.Element {
  if (props.load.status === 'ready') {
    return <p class="page-scope">{pageScope(props.load.storageMode)}</p>;
  }
  if (props.load.status === 'loading') {
    return (
      <p class="page-scope" role="status">
        Checking whether these totals are synced.
      </p>
    );
  }
  return (
    <div class="page-scope page-scope-error" role="alert">
      <span>
        Statistics scope is unavailable. Totals may include synced data. Hourly attempts and recent
        sessions are from this machine.
      </span>
      <button type="button" class="scope-retry" onClick={props.retry}>
        Retry scope check
      </button>
    </div>
  );
}

export function App(): JSX.Element {
  const stats: StatsLoadState = useStats();
  const economyState: EconomyState = useEconomy();
  const attempts: AttemptEventsState = useAttemptEvents();
  const bundle: StatsBundle | null = stats.bundle;
  const economy: PauseEconomy = economyState.economy;
  const events: EventRecord[] | null = attempts.events;
  const partialError: string | null = partialLoadError(attempts.error, economyState.error);
  const setupScope: SetupScopeState = useSetupScope();
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
          <ScopeDisclosure {...setupScope} />
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
