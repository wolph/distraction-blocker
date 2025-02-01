import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../shared/constants';
import { sendRequest } from '../shared/messages';
import type { ListsConfig, SessionSnapshot, Settings } from '../shared/types';
import { ActiveView } from './ActiveView';
import { StartForm } from './StartForm';
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
  const openStats: () => void = (): void => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') });
  };
  const openOptions: () => void = (): void => {
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

function isSettings(value: unknown): value is Settings {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { presetsMin?: unknown }).presetsMin)
  );
}

function isLists(value: unknown): value is ListsConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { categories?: unknown }).categories === 'object'
  );
}

function IdleView(): VNode {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  useEffect((): void => {
    // Boundary guard: a stub or restarting worker may answer with a
    // rejection object instead of the data. Fall back to defaults so the
    // form still renders, the worker validates everything on start anyway.
    void sendRequest({ type: 'getSettings' }).then((s: Settings): void => {
      setSettings(isSettings(s) ? s : DEFAULT_SETTINGS);
    });
    void sendRequest({ type: 'getLists' }).then((l: ListsConfig): void => {
      setLists(isLists(l) ? l : DEFAULT_LISTS);
    });
  }, []);
  if (settings === null || lists === null) {
    return <section class="view" aria-busy="true" />;
  }
  return <StartForm settings={settings} lists={lists} />;
}

function Body({ snapshot, now }: { snapshot: SessionSnapshot; now: number }): VNode {
  if (snapshot.phase === 'idle') {
    return <IdleView />;
  }
  return <ActiveView snapshot={snapshot} now={now} />;
}

export function App(): VNode {
  const {
    error,
    snapshot,
    now,
  }: { snapshot: SessionSnapshot | null; now: number; error: boolean } = useSnapshot();
  return (
    <div class="app">
      <Header />
      {error ? (
        <section class="view snapshot-status" role="status">
          Focus status unavailable
        </section>
      ) : snapshot === null ? (
        <section class="view" aria-busy="true" />
      ) : (
        <Body snapshot={snapshot} now={now} />
      )}
      {snapshot === null ? null : <Footer snapshot={snapshot} />}
    </div>
  );
}
