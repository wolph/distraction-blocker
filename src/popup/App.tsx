import type { VNode } from 'preact';
import type { SessionSnapshot } from '../shared/types';
import { useSnapshot } from './use-snapshot';

const DAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatNextSchedule(startsAt: number): string {
  const d: Date = new Date(startsAt);
  const day: string = DAY_NAMES[d.getDay()] ?? '';
  const hh: string = String(d.getHours()).padStart(2, '0');
  const mm: string = String(d.getMinutes()).padStart(2, '0');
  return `next: ${day} ${hh}:${mm}`;
}

function PadlockGlyph(): VNode {
  return (
    <svg class="padlock" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="2" fill="currentColor" />
      <path
        d="M8 10V7a4 4 0 0 1 8 0v3"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
      />
    </svg>
  );
}

function Header(): VNode {
  const openStats = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') });
  };
  const openOptions = (): void => {
    void chrome.runtime.openOptionsPage();
  };
  return (
    <header class="header">
      <PadlockGlyph />
      <h1 class="title">Focus Lock</h1>
      <span class="spacer" />
      <button type="button" class="icon-button" aria-label="Statistics" onClick={openStats}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            d="M4 20V10M10 20V4M16 20v-8M22 20H2"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <button type="button" class="icon-button" aria-label="Options" onClick={openOptions}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
          <path
            d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M19.1 4.9 17 7m-10 10-2.1 2.1"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </header>
  );
}

function Footer({ snapshot }: { snapshot: SessionSnapshot }): VNode {
  return (
    <footer class="footer">
      <span>{snapshot.attemptsToday} blocked today</span>
      {snapshot.nextSchedule !== null ? (
        <span>{formatNextSchedule(snapshot.nextSchedule.startsAt)}</span>
      ) : null}
    </footer>
  );
}

function Body({ snapshot }: { snapshot: SessionSnapshot; now: number }): VNode {
  if (snapshot.phase === 'idle') {
    return <section class="view">Ready to focus</section>;
  }
  return <section class="view">{snapshot.phase}</section>;
}

export function App(): VNode {
  const { snapshot, now } = useSnapshot();
  return (
    <div class="app">
      <Header />
      {snapshot === null ? (
        <section class="view" aria-busy="true" />
      ) : (
        <Body snapshot={snapshot} now={now} />
      )}
      {snapshot === null ? null : <Footer snapshot={snapshot} />}
    </div>
  );
}
