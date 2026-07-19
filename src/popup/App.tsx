import type { VNode } from 'preact';
import {
  type Dispatch,
  type StateUpdater,
  useCallback,
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
  isBootFailureResponse,
  isListsConfig,
  isSettings,
  isSetupState,
  isWebsiteAccessReconciliation,
} from '../shared/runtime-validation';
import { DATA_CLEAR_ERROR_COPY } from '../shared/session-copy';
import { LOCAL_SETUP } from '../shared/storage-keys';
import { ThemeControl } from '../shared/ThemeControl';
import { applyTheme, updateTheme } from '../shared/theme';
import type {
  BootFailure,
  ListsConfig,
  SessionSnapshot,
  Settings,
  SetupState,
  ThemeMode,
} from '../shared/types';
import { type WebsiteAccessOutcome, websiteAccessOutcome } from '../shared/website-access-state';
import { ActiveView } from './ActiveView';
import { LifecycleView } from './LifecycleView';
import { CATEGORIES_LOCKED_COPY } from './RuleSummary';
import { type StartFeedback, StartForm } from './StartForm';
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

function IdleView({ onStartFeedback }: { onStartFeedback: StartFeedback }): VNode {
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
        onStartFeedback={onStartFeedback}
      />
      {loadError ? (
        <p class="form-error" role="alert">
          Could not load session settings. Reload the popup to try again. Defaults are shown.
          {!listsEditable ? ` ${CATEGORIES_LOCKED_COPY}` : ''}
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
  onStartFeedback,
}: {
  snapshot: SessionSnapshot;
  now: number;
  dataClear: SetupState['dataClear'];
  onStartFeedback: StartFeedback;
}): VNode {
  const journal: SetupState['dataClear'] | null = allDataJournal(dataClear);
  if (journal !== null) {
    return <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />;
  }
  if (snapshot.lifecycle.kind === 'idle') return <IdleView onStartFeedback={onStartFeedback} />;
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

/** The worker did not finish starting. Its setup record carries the overlay that opens this view. */
function bootFailed(setup: SetupState): boolean {
  return setup.storageError === 'boot-failed' || setup.storageError === 'runtime-boot-failed';
}

/** The all-data clear's answer, read exactly. Anything but the worker's own `cleared` is an error. */
function clearAllDataError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return DATA_CLEAR_ERROR_COPY;
  const record: Record<string, unknown> = value as Record<string, unknown>;
  if (record.ok === true && record.scope === 'all' && record.status === 'cleared') return null;
  if (record.ok === false && typeof record.error === 'string' && record.error.trim().length > 0) {
    return record.error;
  }
  return DATA_CLEAR_ERROR_COPY;
}

/**
 * The recovery screen for a worker whose boot failed. The reason comes from the failure channel,
 * which answers while every other request is refused. Retry runs the boot again. The runtime reset
 * is offered only when the stored runtime is what failed, because that is the one stage where
 * parking it costs nothing the person cares about.
 */
function BootFailed(props: { setup: SetupState; onRecovered: () => void }): VNode {
  const [failure, setFailure]: [BootFailure | null, Dispatch<StateUpdater<BootFailure | null>>] =
    useState<BootFailure | null>(null);
  const [reasonUnavailable, setReasonUnavailable]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [pending, setPending]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const [error, setError]: [string | null, Dispatch<StateUpdater<string | null>>] = useState<
    string | null
  >(null);
  const [confirmingDelete, setConfirmingDelete]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  const actionInFlight: { current: boolean } = useRef<boolean>(false);
  const runtimeStage: boolean = props.setup.storageError === 'runtime-boot-failed';

  useEffect((): (() => void) => {
    let alive: boolean = true;
    void sendRequest({ type: 'getBootFailure' })
      .then((response: unknown): void => {
        if (!alive) return;
        if (isBootFailureResponse(response) && response.failure !== null) {
          setFailure(response.failure);
          return;
        }
        setReasonUnavailable(true);
      })
      .catch((): void => {
        if (alive) setReasonUnavailable(true);
      });
    return (): void => {
      alive = false;
    };
  }, []);

  const recover: (request: { type: 'retryBoot' } | { type: 'resetLocalRuntime' }) => Promise<void> =
    async (request: { type: 'retryBoot' } | { type: 'resetLocalRuntime' }): Promise<void> => {
      if (actionInFlight.current) return;
      actionInFlight.current = true;
      setPending(true);
      setError(null);
      try {
        const response: unknown = await sendRequest(request);
        if (!isAck(response)) {
          setError('Could not restart Focus Lock. Try again.');
          return;
        }
        if (!response.ok) {
          setError(response.error);
          return;
        }
        props.onRecovered();
      } catch {
        setError('Could not restart Focus Lock. Try again.');
      } finally {
        actionInFlight.current = false;
        setPending(false);
      }
    };

  /**
   * The way out of a profile no retry can fix. The worker clears everything and boots into setup
   * on its own, so a cleared answer means the popup only has to read the record again.
   */
  const deleteAll: () => Promise<void> = async (): Promise<void> => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const response: unknown = await sendRequest({ type: 'clearFocusLockData', scope: 'all' });
      const clearError: string | null = clearAllDataError(response);
      if (clearError !== null) {
        setError(clearError);
        return;
      }
      setConfirmingDelete(false);
      props.onRecovered();
    } catch {
      setError(DATA_CLEAR_ERROR_COPY);
    } finally {
      actionInFlight.current = false;
      setPending(false);
    }
  };

  return (
    <section class="view setup-required boot-failed" aria-labelledby="boot-failed-heading">
      <h2 id="boot-failed-heading">Focus Lock could not start</h2>
      {failure !== null ? (
        <p role="status">{failure.message}</p>
      ) : reasonUnavailable ? (
        <p role="status">The reason could not be read.</p>
      ) : null}
      <button
        type="button"
        class="start-button"
        disabled={pending}
        onClick={(): void => void recover({ type: 'retryBoot' })}
      >
        Retry
      </button>
      {runtimeStage ? (
        <>
          <button
            type="button"
            class="secondary-button"
            disabled={pending}
            onClick={(): void => void recover({ type: 'resetLocalRuntime' })}
          >
            Reset local runtime
          </button>
          <p>Keeps your settings, lists, and statistics. Clears the current session state.</p>
        </>
      ) : null}
      {confirmingDelete ? (
        <div class="boot-failed__confirm">
          <button
            type="button"
            class="danger-button"
            disabled={pending}
            onClick={(): void => void deleteAll()}
          >
            Delete everything and start over
          </button>
          <button
            type="button"
            class="secondary-button"
            disabled={pending}
            onClick={(): void => setConfirmingDelete(false)}
          >
            Keep my data
          </button>
        </div>
      ) : (
        <button
          type="button"
          class="danger-button"
          disabled={pending}
          onClick={(): void => setConfirmingDelete(true)}
        >
          Delete all Focus Lock data
        </button>
      )}
      {error !== null ? (
        <p role="alert" class="form-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export function App(): VNode {
  /** Bumped after a recovery so the snapshot is read again from the worker that now runs. */
  const [snapshotVersion, setSnapshotVersion]: [number, Dispatch<StateUpdater<number>>] =
    useState<number>(0);
  const {
    error,
    snapshot,
    now,
  }: { snapshot: SessionSnapshot | null; now: number; error: boolean } =
    useSnapshot(snapshotVersion);
  const [theme, setTheme]: [ThemeMode | null, Dispatch<StateUpdater<ThemeMode | null>>] =
    useState<ThemeMode | null>(null);
  const [setup, setSetup]: [SetupState | null, Dispatch<StateUpdater<SetupState | null>>] =
    useState<SetupState | null>(null);
  const [setupError, setSetupError]: [boolean, Dispatch<StateUpdater<boolean>>] =
    useState<boolean>(false);
  /**
   * A start that succeeded except for its work tab answers after the snapshot has already
   * replaced the form, so the form hands the message up here, where it outlives the form.
   */
  const [startFeedback, setStartFeedback]: [string | null, Dispatch<StateUpdater<string | null>>] =
    useState<string | null>(null);
  const onStartFeedback: StartFeedback = (message: string | null): void => {
    setStartFeedback(message);
  };
  useEffect((): void => {
    if (snapshot?.lifecycle.kind === 'idle') setStartFeedback(null);
  }, [snapshot]);

  /** Guards a read that lands after the popup closed. Set once the effect below is torn down. */
  const disposed: { current: boolean } = useRef<boolean>(false);
  const readSetup: () => void = useCallback((): void => {
    void sendRequest({ type: 'getSetupState' })
      .then((value: SetupState): void => {
        if (disposed.current) return;
        if (!isSetupState(value)) {
          setSetupError(true);
          return;
        }
        setSetupError(false);
        setSetup(value);
      })
      .catch((): void => {
        if (!disposed.current) setSetupError(true);
      });
  }, []);

  useEffect((): (() => void) => {
    disposed.current = false;
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
      disposed.current = true;
      chrome.storage.onChanged.removeListener(onStored);
    };
  }, [readSetup]);

  /** A recovery means the worker runs now: the setup record and the snapshot are read again. */
  const onRecovered: () => void = (): void => {
    readSetup();
    setSnapshotVersion((version: number): number => version + 1);
  };

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
        <section class="view snapshot-status snapshot-status--retry" role="alert">
          <span>Setup status unavailable. Reload Focus Lock to try again.</span>
          <button type="button" class="secondary-button" onClick={readSetup}>
            Retry
          </button>
        </section>
      ) : setup === null ? (
        <section class="view" aria-busy="true" />
      ) : journal !== null ? (
        <LifecycleView snapshot={snapshot} now={now} dataClear={journal} />
      ) : bootFailed(setup) ? (
        <BootFailed setup={setup} onRecovered={onRecovered} />
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
        <Body
          snapshot={snapshot}
          now={now}
          dataClear={setup.dataClear}
          onStartFeedback={onStartFeedback}
        />
      )}
      {startFeedback !== null ? (
        <p class="view form-error" role="alert">
          {startFeedback}
        </p>
      ) : null}
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
