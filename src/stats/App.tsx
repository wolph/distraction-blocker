import type { JSX } from 'preact';
import type { StatsBundle } from '../shared/messages';
import type { PauseEconomy } from '../shared/types';
import { Streak } from './Streak';
import { Tiles } from './Tiles';
import { useEconomy, useStats } from './use-stats';

export function App(): JSX.Element {
  const bundle: StatsBundle | null = useStats();
  const economy: PauseEconomy = useEconomy();
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
        </>
      )}
    </main>
  );
}
