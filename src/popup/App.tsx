import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../shared/constants';
import { sendRequest } from '../shared/messages';
import { WEBSITE_ORIGINS } from '../shared/permissions';
import {
  isAck,
  isListsConfig,
  isSettings,
  isSetupState,
  isWebsiteAccessReconciliation,
} from '../shared/runtime-validation';
import { LOCAL_SETUP } from '../shared/storage-keys';
import { ThemeControl } from '../shared/ThemeControl';
import { applyTheme, updateTheme } from '../shared/theme';
import type {
  ListsConfig,
  SessionSnapshot,
  Settings,
  SetupState,
  ThemeMode,
} from '../shared/types';
import { type WebsiteAccessOutcome, websiteAccessOutcome } from '../shared/website-access-state';
import { ActiveView } from './ActiveView';
import { LifecycleView } from './LifecycleView';
import { StartForm } from './StartForm';
import { useSnapshot } from './use-snapshot';

const DAY_NAMES: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function formatNextSchedule(startsAt: number): string {
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
          <svg
            class="settings-cog"
            data-icon="settings"
            viewBox="0 0 24 24"
            width="16"
            height="16"
            aria-hidden="true"
          >
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

function IdleView({ startsDisabled }: { startsDisabled: boolean }): VNode {
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
      <StartForm
        settings={settings}
        lists={lists}
        categoriesEditable={listsEditable}
        startsDisabled={startsDisabled}
      />
      {loadError ? (
        <p class="form-error" role="alert">
          Could not load session settings. Reload the popup to try again. Defaults are shown.
          {!listsEditable ? ' Category editing is disabled until blocked-site lists reload.' : ''}
        </p>
      ) : null}
    </>
  );
}

/**
 * The all-data journal the popup must render over every setup gate, or null when no such
 * journal exists. The worker writes DEFAULT_SETUP with the journal attached from the local
 * phase onward, so `completed` is false and `blockingRegistration` is unavailable while the
 * profile is being deleted: reading the journal before those gates is the only way the
 * deleting copy and the exhausted-clear retry are reachable.
 */
function allDataJournal(dataClear: SetupState['dataClear']): SetupState['dataClear'] | null {
  const active: boolean =
    dataClear.scope === 'all' && (dataClear.status === 'pending' || dataClear.status === 'error');
  return active ? dataClear : null;
}

/**
 * One switch from the public lifecycle to the view that owns it. An all-data journal outranks every
 * lifecycle, including idle, because the profile is being deleted and no session may start on top
 * of that. Nothing else disables a start on an idle lifecycle, and no branch offers one while a
 * journal exists.
 */
function Body({
  snapshot,
  now,
  dataClear,
}: {
  snapshot: SessionSnapshot;
  now: number;
  dataClear: SetupState['dataClear'];
}): VNode {
  const journal: SetupState['dataClear'] | null = allDataJournal(dataClear);
  if (journal !== null) {
    return <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />;
  }
  if (snapshot.lifecycle.kind === 'idle') return <IdleView startsDisabled={false} />;
  if (snapshot.lifecycle.kind === 'active') return <ActiveView snapshot={snapshot} now={now} />;
  return <LifecycleView snapshot={snapshot} now={now} dataClear={dataClear} />;
}

function SetupRequired(): VNode {
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const openSetup: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'openOnboarding' });
      if (!isAck(response)) throw new Error('invalid setup response');
      if (!response.ok) throw new Error(response.error);
    } catch {
      setError('Could not open setup. Try again.');
    } finally {
      setPending(false);
    }
  };
  return (
    <section class="view setup-required" aria-labelledby="setup-required-heading">
      <h2 id="setup-required-heading">Finish setting up Focus Lock</h2>
      <p>Choose your starting lists, website access, and storage mode before starting a session.</p>
      <button
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void openSetup()}
      >
        Open setup
      </button>
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function WebsiteBlockingOff(props: {
  setup: SetupState;
  onReconciled: (setup: SetupState) => void;
}): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [attempted, setAttempted]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);
  const enableButton: { current: HTMLButtonElement | null } = useRef<HTMLButtonElement>(null);
  const restoreEnableFocus: { current: boolean } = useRef<boolean>(false);
  const denied: boolean = props.setup.websiteAccess === 'denied';
  const registrationError: boolean =
    props.setup.websiteAccess === 'granted' && props.setup.blockingRegistration === 'error';

  useLayoutEffect((): void => {
    if (pending || !restoreEnableFocus.current) return;
    restoreEnableFocus.current = false;
    const active: Element | null = document.activeElement;
    if (active === document.body || active === enableButton.current) {
      enableButton.current?.focus();
    }
  }, [pending]);

  const enable: () => Promise<void> = async (): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    restoreEnableFocus.current = true;
    setAttempted(true);
    setPending(true);
    setError(null);
    try {
      await chrome.permissions.request({ origins: [...WEBSITE_ORIGINS] });
      const response: unknown = await sendRequest({ type: 'reconcileWebsiteAccess' });
      if (!isWebsiteAccessReconciliation(response)) {
        setError('Could not confirm website blocking. Try again.');
        return;
      }
      const outcome: WebsiteAccessOutcome = websiteAccessOutcome(response);
      if (outcome.kind === 'ready') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'granted',
          blockingRegistration: 'ready',
          websiteAccessNotice: null,
        });
        return;
      }
      if (outcome.kind === 'denied') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'denied',
          blockingRegistration: 'unavailable',
        });
        if (outcome.error !== null) setError(outcome.error);
        return;
      }
      if (outcome.kind === 'registration-error') {
        props.onReconciled({
          ...props.setup,
          websiteAccess: 'granted',
          blockingRegistration: 'error',
        });
        setError(outcome.error);
        return;
      }
      setError(outcome.error);
    } catch {
      setError('Could not enable website blocking. Try again.');
    } finally {
      actionInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section
      class="view setup-required website-blocking-off"
      aria-labelledby="blocking-off-heading"
    >
      <h2 id="blocking-off-heading">Website blocking is off</h2>
      <p>
        Focus Lock cannot start a session until Chrome grants website access and blocking is
        enabled.
      </p>
      {denied ? (
        <p role="status">Chrome did not grant website access. Website blocking is still off.</p>
      ) : null}
      {registrationError ? (
        <p role="status">
          Website access is granted, but Focus Lock could not enable blocking. Retry setup or reload
          the extension.
        </p>
      ) : null}
      <button
        ref={enableButton}
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void enable()}
      >
        {attempted ? 'Retry' : 'Enable website blocking'}
      </button>
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function WebsiteAccessNotice(props: {
  notice: Exclude<SetupState['websiteAccessNotice'], null>;
  onDismissed: () => void;
}): VNode {
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const message: string =
    props.notice === 'revoked-during-session'
      ? 'Your session ended because website access was removed.'
      : 'Your session ended because Focus Lock could not enable website blocking.';
  const dismiss: () => Promise<void> = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'dismissWebsiteAccessNotice' });
      if (!isAck(response)) {
        setError('Could not dismiss this notice. Try again.');
        return;
      }
      if (!response.ok) {
        setError(response.error);
        return;
      }
      props.onDismissed();
    } catch {
      setError('Could not dismiss this notice. Try again.');
    } finally {
      setPending(false);
    }
  };
  return (
    <aside class="website-access-notice" role="status">
      <span>{message}</span>
      <button
        type="button"
        aria-label="Dismiss website access notice"
        disabled={pending}
        onClick={(): void => void dismiss()}
      >
        Dismiss
      </button>
      {error !== null ? <span role="alert">{error}</span> : null}
    </aside>
  );
}

export function App(): VNode {
  const {
    error,
    snapshot,
    now,
  }: { snapshot: SessionSnapshot | null; now: number; error: boolean } = useSnapshot();
  const [theme, setTheme]: [ThemeMode | null, Dispatch<StateUpdater<ThemeMode | null>>] =
    useState<ThemeMode | null>(null);
  const [setup, setSetup]: [SetupState | null, Dispatch<StateUpdater<SetupState | null>>] =
    useState<SetupState | null>(null);
  const [setupError, setSetupError]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);

  useEffect((): (() => void) => {
    let alive: boolean = true;
    const readSetup: () => void = (): void => {
      void sendRequest({ type: 'getSetupState' })
        .then((value: SetupState): void => {
          if (!alive) return;
          if (!isSetupState(value)) {
            setSetupError(true);
            return;
          }
          setSetupError(false);
          setSetup(value);
        })
        .catch((): void => {
          if (alive) setSetupError(true);
        });
    };
    readSetup();
    /**
     * The snapshot is live through the stateChanged broadcast, but the setup record is not, and
     * no setupChanged broadcast exists. A data-clear journal is written straight into that
     * record, and its browser-reset phase is worker-initiated, so a popup that read the record
     * once would keep offering the wrong branch while the profile is being deleted. Every write
     * lands on one local key, so the popup rereads through the worker whenever it changes.
     */
    const onStored: (changes: Record<string, chrome.storage.StorageChange>, area: string) => void =
      (changes: Record<string, chrome.storage.StorageChange>, area: string): void => {
        if (area !== 'local' || !Object.hasOwn(changes, LOCAL_SETUP)) return;
        readSetup();
      };
    chrome.storage.onChanged.addListener(onStored);
    return (): void => {
      alive = false;
      chrome.storage.onChanged.removeListener(onStored);
    };
  }, []);

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

  const journal: SetupState['dataClear'] | null =
    setup === null ? null : allDataJournal(setup.dataClear);
  /**
   * A closure that ended for `website-access-lost` leaves blocking unavailable while its own
   * cleanup or error still needs the user, and Settings tells that user to open the popup and
   * retry. So cleanup and error outrank the website-blocking screen: stale enforcement pixels
   * are not runtime authority, and the retry has to be reachable where the copy promises it.
   */
  const attentionSnapshot: SessionSnapshot | null =
    snapshot !== null &&
    (snapshot.lifecycle.kind === 'cleanup' || snapshot.lifecycle.kind === 'error')
      ? snapshot
      : null;

  return (
    <div class="app">
      <Header theme={theme} onThemeChange={saveTheme} />
      {setupError ? (
        <section class="view snapshot-status" role="alert">
          Setup status unavailable. Reload Focus Lock to try again.
        </section>
      ) : setup === null ? (
        <section class="view" aria-busy="true" />
      ) : journal !== null ? (
        <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />
      ) : !setup.completed ? (
        <SetupRequired />
      ) : attentionSnapshot !== null ? (
        <LifecycleView snapshot={attentionSnapshot} now={now} dataClear={setup.dataClear} />
      ) : setup.blockingRegistration !== 'ready' ? (
        <WebsiteBlockingOff setup={setup} onReconciled={setSetup} />
      ) : error ? (
        <section class="view snapshot-status" role="status">
          Focus status unavailable
        </section>
      ) : snapshot === null ? (
        <section class="view" aria-busy="true" />
      ) : (
        <Body snapshot={snapshot} now={now} dataClear={setup.dataClear} />
      )}
      {setup?.completed &&
      setup.blockingRegistration !== 'ready' &&
      setup.websiteAccessNotice !== null ? (
        <WebsiteAccessNotice
          notice={setup.websiteAccessNotice}
          onDismissed={(): void => setSetup({ ...setup, websiteAccessNotice: null })}
        />
      ) : null}
      {setup?.completed === true && snapshot !== null ? <Footer snapshot={snapshot} /> : null}
    </div>
  );
}
