import type { VNode } from 'preact';
import { type Dispatch, type StateUpdater, useEffect, useState } from 'preact/hooks';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../shared/constants';
import { sendRequest } from '../shared/messages';
import { isListsConfig, isSettings } from '../shared/runtime-validation';
import { ThemeControl } from '../shared/ThemeControl';
import { applyTheme, updateTheme } from '../shared/theme';
import type { ListsConfig, SessionSnapshot, Settings, ThemeMode } from '../shared/types';
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

function Header(props: {
  theme: ThemeMode | null;
  onThemeChange: (next: ThemeMode) => Promise<string | null>;
}): VNode {
  const [pending, setPending]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);

  const openPage: (destination: 'Statistics' | 'Options') => Promise<void> = async (
    destination: 'Statistics' | 'Options',
  ): Promise<void> => {
    setError(null);
    setPending(destination);
    try {
      if (destination === 'Statistics') {
        await chrome.tabs.create({ url: chrome.runtime.getURL('src/stats/stats.html') });
      } else {
        await chrome.runtime.openOptionsPage();
      }
    } catch {
      setError(`Could not open ${destination}. Try again.`);
    } finally {
      setPending(null);
    }
  };
  return (
    <>
      <header class="header">
        <PadlockGlyph />
        <h1 class="title">Focus Lock</h1>
        <span class="spacer" />
        <button
          type="button"
          class="icon-button"
          aria-label="Statistics"
          disabled={pending !== null}
          onClick={(): void => void openPage('Statistics')}
        >
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
        <ThemeControl mode={props.theme} onChange={props.onThemeChange} className="popup-theme" />
        <button
          type="button"
          class="icon-button"
          aria-label="Options"
          disabled={pending !== null}
          onClick={(): void => void openPage('Options')}
        >
          <svg data-icon="settings" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2" />
            <path
              d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </header>
      {error !== null ? (
        <p class="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </>
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

function IdleView(): VNode {
  const [settings, setSettings]: [Settings | null, Dispatch<StateUpdater<Settings | null>>] =
    useState<Settings | null>(null);
  const [lists, setLists]: [ListsConfig | null, Dispatch<StateUpdater<ListsConfig | null>>] =
    useState<ListsConfig | null>(null);
  const [loadError, setLoadError]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [listsEditable, setListsEditable]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  useEffect((): void => {
    // Boundary guard: a stub or restarting worker may answer with a
    // rejection object instead of the data. Fall back to defaults so the
    // form still renders, the worker validates everything on start anyway.
    void sendRequest({ type: 'getSettings' })
      .then((s: Settings): void => {
        const valid: boolean = isSettings(s);
        setSettings(valid ? s : DEFAULT_SETTINGS);
        if (!valid) setLoadError(true);
      })
      .catch((): void => {
        setSettings(DEFAULT_SETTINGS);
        setLoadError(true);
      });
    void sendRequest({ type: 'getLists' })
      .then((l: ListsConfig): void => {
        const valid: boolean = isListsConfig(l);
        setLists(valid ? l : DEFAULT_LISTS);
        setListsEditable(valid);
        if (!valid) setLoadError(true);
      })
      .catch((): void => {
        setLists(DEFAULT_LISTS);
        setListsEditable(false);
        setLoadError(true);
      });
  }, []);
  if (settings === null || lists === null) {
    return <section class="view" aria-busy="true" />;
  }
  return (
    <>
      <StartForm settings={settings} lists={lists} categoriesEditable={listsEditable} />
      {loadError ? (
        <p class="form-error" role="alert">
          Could not load session settings. Reload the popup to try again. Defaults are shown.
          {!listsEditable ? ' Category editing is disabled until blocked-site lists reload.' : ''}
        </p>
      ) : null}
    </>
  );
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
  const [theme, setTheme]: [ThemeMode | null, Dispatch<StateUpdater<ThemeMode | null>>] =
    useState<ThemeMode | null>(null);

  useEffect((): void => {
    if (snapshot !== null) setTheme(snapshot.theme);
  }, [snapshot]);

  useEffect((): void => {
    if (theme !== null) applyTheme(document.documentElement, theme);
  }, [theme]);

  const saveTheme: (next: ThemeMode) => Promise<string | null> = async (
    next: ThemeMode,
  ): Promise<string | null> => {
    const saveError: string | null = await updateTheme(next);
    if (saveError === null) setTheme(next);
    return saveError;
  };

  return (
    <div class="app">
      <Header theme={theme} onThemeChange={saveTheme} />
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
