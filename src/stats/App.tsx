import type { JSX } from 'preact';
import type { StatsBundle } from '../shared/messages';
import type { EventRecord, PauseEconomy } from '../shared/types';
import { Charts } from './Charts';
import { SessionLog } from './SessionLog';
import { Streak } from './Streak';
import { Tiles } from './Tiles';
import { useAttemptEvents, useEconomy, useStats } from './use-stats';

export function App(): JSX.Element {
  const bundle: StatsBundle | null = useStats();
  const economy: PauseEconomy = useEconomy();
  const events: EventRecord[] | null = useAttemptEvents();
  const now: number = Date.now();
  return (
    <main class="stats-page">
      <header class="page-header">
        <h1>Your focus record</h1>
      </header>
      {bundle === null ? (
        <p class="empty-line">Loading your stats.</p>
      ) : (
        <>
          <Tiles bundle={bundle} economy={economy} now={now} />
          <Streak streak={bundle.streak} now={now} />
          <Charts bundle={bundle} events={events} now={now} />
          <SessionLog events={bundle.recentSessions} />
        </>
      )}
    </main>
  );
}
