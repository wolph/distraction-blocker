import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import type { StatsBundle } from '../shared/messages';
import { SettingsNav } from '../shared/SettingsNav';
import { applyTheme } from '../shared/theme';
import type { EventRecord, PauseEconomy } from '../shared/types';
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
  if (attempts && economy)
    return 'Hourly attempts and site access credit settings are unavailable.';
  if (attempts) return 'Hourly attempts are unavailable.';
  if (economy) return 'Site access credit settings are unavailable.';
  return null;
}

export function App(): JSX.Element {
  const stats: StatsLoadState = useStats();
  const economyState: EconomyState = useEconomy();
  const attempts: AttemptEventsState = useAttemptEvents();
  const bundle: StatsBundle | null = stats.bundle;
  const economy: PauseEconomy = economyState.economy;
  const events: EventRecord[] | null = attempts.events;
  const partialError: string | null = partialLoadError(attempts.error, economyState.error);
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
