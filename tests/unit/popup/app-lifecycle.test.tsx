/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { App } from '../../../src/popup/App';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import {
  DATA_CLEAR_ERROR_COPY,
  DATA_CLEAR_PENDING_COPY,
  POPUP_CLOSURE_CLEANUP_COPY,
  POPUP_CLOSURE_ERROR_COPY,
  POPUP_STARTING_COPY,
  POPUP_TRANSITION_CLEANUP_COPY,
  POPUP_TRANSITION_ERROR_COPY,
  RETRY_CLEANUP_LABEL,
} from '../../../src/shared/session-copy';
import type { SessionLifecycleV2, SessionSnapshot, SetupState } from '../../../src/shared/types';
import { emitStorageChange, resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
/** A closure journal is named by the closed session's UUID plus the close suffix. */
const CLOSURE_ID: string = '10000000-0000-4000-8000-000000000001:close';
/** A transition journal is named by the id the runtime minted for the failed start. */
const TRANSITION_ID: string = '30000000-0000-4000-8000-000000000001';
const START_BUTTON: RegExp = /^Start 25 min/;
const SETUP_HEADING: string = 'Finish setting up Focus Lock';
const BLOCKING_OFF_HEADING: string = 'Website blocking is off';
const BOOT_FAILED_HEADING: string = 'Focus Lock could not start';
const RESET_RUNTIME_LABEL: string = 'Reset local runtime';
const DELETE_ALL_LABEL: string = 'Delete all Focus Lock data';
const DELETE_CONFIRM_LABEL: string = 'Delete everything and start over';
const KEEP_DATA_LABEL: string = 'Keep my data';

/**
 * jsdom refuses to redefine location's own properties, so the whole global is stubbed. The spread
 * carries the URL, which the assertion pins so a jsdom that moved those attributes onto the
 * prototype would fail here rather than far away.
 */
function stubReload(): Mock<() => void> {
  const reload: Mock<() => void> = vi.fn<() => void>();
  const href: string = window.location.href;
  vi.stubGlobal('location', { ...window.location, reload });
  expect(location.href).toBe(href);
  return reload;
}

const COMPLETED_SETUP: SetupState = {
  ...DEFAULT_SETUP,
  completed: true,
  storageMode: 'local',
  websiteAccess: 'granted',
  blockingRegistration: 'ready',
};

const STATS: StatsBundle = {
  days: [],
  months: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  },
  recentSessions: [],
  totals: { focusMsToday: 0, focusMsLast7Days: 0, attemptsToday: 0, resistedToday: 0 },
};

/** The all-data journal states the popup must honour over idle Setup. */
const ALL_DATA_PENDING: SetupState['dataClear'] = {
  status: 'pending',
  scope: 'all',
  phase: 'local',
};
const ALL_DATA_ERROR: SetupState['dataClear'] = {
  status: 'error',
  scope: 'all',
  phase: 'local',
};
const ALL_DATA_PENDING_REMOTE: SetupState['dataClear'] = {
  status: 'pending',
  scope: 'all',
  phase: 'remote',
};

/**
 * What a website-access-lost closure leaves behind: the session ended because Chrome
 * revoked host access, so blocking is unavailable while the closure still cleans up.
 */
const ACCESS_LOST_SETUP: SetupState = {
  ...COMPLETED_SETUP,
  websiteAccess: 'denied',
  blockingRegistration: 'unavailable',
  websiteAccessNotice: 'revoked-during-session',
};

/**
 * What the worker actually stores from the local phase onward: policy-storage writes
 * DEFAULT_SETUP with the journal attached, so `completed` is false and the registration is
 * unavailable while the profile is being deleted.
 */
function incompleteSetup(dataClear: SetupState['dataClear']): SetupState {
  return { ...DEFAULT_SETUP, dataClear };
}

function activeSnapshot(): SessionSnapshot {
  const startedAt: number = NOW - 5 * 60_000;
  return {
    ...emptySnapshot(NOW),
    // Flexible ends on request, so the authority is the immediate one.
    lifecycle: { kind: 'active', endAuthority: { kind: 'immediate', actionLabel: 'End session' } },
    phase: 'focus',
    config: {
      mode: 'blacklist',
      strictness: 'flexible',
      duration: { kind: 'timed', minutes: 25 },
      cycling: null,
      intention: 'write the report',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    },
    startedAt,
    phaseStartedAt: startedAt,
    phaseEndsAt: startedAt + 25 * 60_000,
    sessionEndsAt: startedAt + 25 * 60_000,
    sessionFocusedMs: NOW - startedAt,
  };
}

function lifecycleSnapshot(lifecycle: SessionLifecycleV2): SessionSnapshot {
  return { ...emptySnapshot(NOW), lifecycle };
}

function install(snapshot: SessionSnapshot, dataClear: SetupState['dataClear']): void {
  installSetup(snapshot, { ...COMPLETED_SETUP, dataClear });
}

function installSetup(snapshot: SessionSnapshot, setup: SetupState): void {
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return setup;
    if (request.type === 'getSnapshot') return snapshot;
    if (request.type === 'getSettings') return DEFAULT_SETTINGS;
    if (request.type === 'getLists') return DEFAULT_LISTS;
    if (request.type === 'getStats') return STATS;
    return { ok: true };
  });
}

/**
 * A worker whose boot failed: the setup record carries the overlay, the failure channel names the
 * stage and the reason, and every other request is refused until Retry or the reset succeeds. A
 * successful Retry flips the worker to a running one, which the form then reads normally.
 */
function installBootFailure(
  storageError: 'boot-failed' | 'runtime-boot-failed',
  stage: 'policy-storage' | 'runtime' | 'engine',
  message: string,
  extra: (request: Request) => unknown = (): undefined => undefined,
): void {
  let running: boolean = false;
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    const handled: unknown = extra(request);
    if (handled !== undefined) {
      running = true;
      return handled;
    }
    if (request.type === 'getBootFailure') {
      return { ok: true, failure: running ? null : { stage, message, at: NOW } };
    }
    if (request.type === 'retryBoot') {
      running = true;
      return { ok: true };
    }
    if (request.type === 'getSetupState') {
      return running ? COMPLETED_SETUP : { ...COMPLETED_SETUP, storageError };
    }
    if (!running) return { ok: false, error: `Focus Lock did not finish starting: ${message}` };
    if (request.type === 'getSnapshot') return emptySnapshot(NOW);
    if (request.type === 'getSettings') return DEFAULT_SETTINGS;
    if (request.type === 'getLists') return DEFAULT_LISTS;
    if (request.type === 'getStats') return STATS;
    return { ok: true };
  });
}

describe('popup lifecycle body', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    sessionStorage.clear();
    tabsQueryMock.mockResolvedValue([{ url: 'https://example.com/' }]);
  });

  afterEach((): void => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the start form while idle without a journal', async (): Promise<void> => {
    install(emptySnapshot(NOW), DEFAULT_SETUP.dataClear);
    const { getByRole } = render(h(App, null));

    const start: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: START_BUTTON }) as HTMLButtonElement,
    );
    expect(start.disabled).toBe(false);
  });

  it('renders the pending all-data journal over an idle lifecycle', async (): Promise<void> => {
    install(emptySnapshot(NOW), ALL_DATA_PENDING);
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_PENDING_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the all-data journal before any snapshot has arrived', async (): Promise<void> => {
    // The journal ladder sits above the snapshot guard, so LifecycleView's documented
    // `snapshot: null` branch is reachable: the copy comes from the journal, not the session.
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState')
        return { ...COMPLETED_SETUP, dataClear: ALL_DATA_PENDING };
      if (request.type === 'getSnapshot') return new Promise<never>((): void => {});
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'getLists') return DEFAULT_LISTS;
      if (request.type === 'getStats') return STATS;
      return { ok: true };
    });
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_PENDING_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('offers the cleanup retry for an exhausted all-data journal', async (): Promise<void> => {
    install(emptySnapshot(NOW), ALL_DATA_ERROR);
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_ERROR_COPY);
    });
    expect(getByRole('button', { name: RETRY_CLEANUP_LABEL })).toBeTruthy();
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the deleting copy while an all-data clear runs its local phase', async (): Promise<void> => {
    installSetup(emptySnapshot(NOW), incompleteSetup(ALL_DATA_PENDING));
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_PENDING_COPY);
    });
    expect(queryByRole('heading', { name: SETUP_HEADING })).toBeNull();
    expect(queryByRole('button', { name: 'Open setup' })).toBeNull();
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the deleting copy while an all-data clear runs its remote phase', async (): Promise<void> => {
    installSetup(emptySnapshot(NOW), { ...COMPLETED_SETUP, dataClear: ALL_DATA_PENDING_REMOTE });
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_PENDING_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('offers the cleanup retry when an all-data clear exhausts in its local phase', async (): Promise<void> => {
    installSetup(emptySnapshot(NOW), incompleteSetup(ALL_DATA_ERROR));
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_ERROR_COPY);
    });
    expect(getByRole('button', { name: RETRY_CLEANUP_LABEL })).toBeTruthy();
    expect(queryByRole('heading', { name: SETUP_HEADING })).toBeNull();
    expect(queryByRole('button', { name: 'Open setup' })).toBeNull();
  });

  it('renders the closure cleanup error over the website-blocking screen', async (): Promise<void> => {
    installSetup(
      lifecycleSnapshot({
        kind: 'error',
        code: 'closure-cleanup-failed',
        retryAvailable: true,
        endAuthority: { kind: 'hidden' },
      }),
      ACCESS_LOST_SETUP,
    );
    const { getByRole, getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText(POPUP_CLOSURE_ERROR_COPY)).toBeTruthy();
    });
    expect(getByRole('button', { name: RETRY_CLEANUP_LABEL })).toBeTruthy();
    expect(queryByRole('heading', { name: BLOCKING_OFF_HEADING })).toBeNull();
  });

  it('renders closure cleanup over the website-blocking screen', async (): Promise<void> => {
    installSetup(
      lifecycleSnapshot({
        kind: 'cleanup',
        journal: 'closure',
        id: CLOSURE_ID,
        endAuthority: { kind: 'hidden' },
      }),
      ACCESS_LOST_SETUP,
    );
    const { getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText(POPUP_CLOSURE_CLEANUP_COPY)).toBeTruthy();
    });
    expect(queryByRole('heading', { name: BLOCKING_OFF_HEADING })).toBeNull();
  });

  it('renders the transition cleanup error over the website-blocking screen', async (): Promise<void> => {
    installSetup(
      lifecycleSnapshot({
        kind: 'error',
        code: 'transition-cleanup-failed',
        retryAvailable: true,
        endAuthority: { kind: 'hidden' },
      }),
      ACCESS_LOST_SETUP,
    );
    const { getByRole, getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText(POPUP_TRANSITION_ERROR_COPY)).toBeTruthy();
    });
    expect(getByRole('button', { name: RETRY_CLEANUP_LABEL })).toBeTruthy();
    expect(queryByRole('heading', { name: BLOCKING_OFF_HEADING })).toBeNull();
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders transition cleanup over the website-blocking screen', async (): Promise<void> => {
    installSetup(
      lifecycleSnapshot({
        kind: 'cleanup',
        journal: 'transition',
        id: TRANSITION_ID,
        endAuthority: { kind: 'hidden' },
      }),
      ACCESS_LOST_SETUP,
    );
    const { getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText(POPUP_TRANSITION_CLEANUP_COPY)).toBeTruthy();
    });
    expect(queryByRole('heading', { name: BLOCKING_OFF_HEADING })).toBeNull();
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the lifecycle view while starting', async (): Promise<void> => {
    install(
      lifecycleSnapshot({
        kind: 'starting',
        operationId: OPERATION_ID,
        transition: 'start',
        endAuthority: { kind: 'hidden' },
      }),
      DEFAULT_SETUP.dataClear,
    );
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(POPUP_STARTING_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the lifecycle view while a closure journal is cleaning up', async (): Promise<void> => {
    install(
      lifecycleSnapshot({
        kind: 'cleanup',
        journal: 'closure',
        id: CLOSURE_ID,
        endAuthority: { kind: 'hidden' },
      }),
      DEFAULT_SETUP.dataClear,
    );
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(POPUP_CLOSURE_CLEANUP_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('rereads the setup record when the journal is written while the popup is open', async (): Promise<void> => {
    installSetup(emptySnapshot(NOW), COMPLETED_SETUP);
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('button', { name: START_BUTTON })).toBeTruthy();
    });

    installSetup(emptySnapshot(NOW), incompleteSetup(ALL_DATA_PENDING));
    emitStorageChange({ setup: { newValue: incompleteSetup(ALL_DATA_PENDING) } });

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_PENDING_COPY);
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the active view for an active lifecycle', async (): Promise<void> => {
    install(activeSnapshot(), DEFAULT_SETUP.dataClear);
    const { getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText('write the report')).toBeTruthy();
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });

  it('renders the boot failure screen with the reason and Retry for boot-failed', async (): Promise<void> => {
    const reload: Mock<() => void> = stubReload();
    installBootFailure('boot-failed', 'policy-storage', 'invalid local setup state');
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('heading', { name: BOOT_FAILED_HEADING })).toBeTruthy();
    });
    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe('invalid local setup state');
    });
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(getByRole('button', { name: DELETE_ALL_LABEL })).toBeTruthy();
    expect(queryByRole('button', { name: RESET_RUNTIME_LABEL })).toBeNull();
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
    expect(queryByRole('heading', { name: BLOCKING_OFF_HEADING })).toBeNull();
    // The worker's rejection is a refusal, not a stale page: no reload before the screen lands.
    expect(reload).not.toHaveBeenCalled();
  });

  it('renders an active all-data journal ahead of the boot failure screen', async (): Promise<void> => {
    // A deletion that is still running, or waiting for its retry, is the way out of a profile
    // that cannot boot, so its copy and its retry outrank the failure screen.
    installSetup(emptySnapshot(NOW), {
      ...COMPLETED_SETUP,
      storageError: 'boot-failed',
      dataClear: ALL_DATA_ERROR,
    });
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('status').textContent).toBe(DATA_CLEAR_ERROR_COPY);
    });
    expect(getByRole('button', { name: RETRY_CLEANUP_LABEL })).toBeTruthy();
    expect(queryByRole('heading', { name: BOOT_FAILED_HEADING })).toBeNull();
  });

  it('deletes all data from the boot failure screen after an inline confirmation', async (): Promise<void> => {
    let cleared: boolean = false;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'clearFocusLockData') {
        expect(request).toEqual({ type: 'clearFocusLockData', scope: 'all' });
        cleared = true;
        return { ok: true, scope: 'all', status: 'cleared' };
      }
      if (request.type === 'getSetupState') {
        return cleared ? { ...DEFAULT_SETUP } : { ...COMPLETED_SETUP, storageError: 'boot-failed' };
      }
      if (request.type === 'getBootFailure') {
        return {
          ok: true,
          failure: cleared
            ? null
            : { stage: 'policy-storage', message: 'invalid local setup state', at: NOW },
        };
      }
      if (!cleared) return { ok: false, error: 'Focus Lock did not finish starting: stopped' };
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      return { ok: true };
    });
    const { getByRole, queryByRole } = render(h(App, null));

    const first: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: DELETE_ALL_LABEL }) as HTMLButtonElement,
    );
    expect(queryByRole('button', { name: DELETE_CONFIRM_LABEL })).toBeNull();

    // The first press only asks. Keeping the data returns to the first control.
    fireEvent.click(first);
    expect(getByRole('button', { name: DELETE_CONFIRM_LABEL })).toBeTruthy();
    expect(queryByRole('button', { name: DELETE_ALL_LABEL })).toBeNull();
    fireEvent.click(getByRole('button', { name: KEEP_DATA_LABEL }));
    expect(getByRole('button', { name: DELETE_ALL_LABEL })).toBeTruthy();
    expect(queryByRole('button', { name: DELETE_CONFIRM_LABEL })).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalledWith({ type: 'clearFocusLockData', scope: 'all' });

    fireEvent.click(getByRole('button', { name: DELETE_ALL_LABEL }));
    fireEvent.click(getByRole('button', { name: DELETE_CONFIRM_LABEL }));

    // The worker cleared the profile and booted into setup on its own, and the popup follows.
    await waitFor((): void => {
      expect(getByRole('heading', { name: SETUP_HEADING })).toBeTruthy();
    });
    expect(cleared).toBe(true);
    expect(queryByRole('heading', { name: BOOT_FAILED_HEADING })).toBeNull();
  });

  it('shows the worker refusal when the deletion from the boot failure screen fails', async (): Promise<void> => {
    installBootFailure(
      'boot-failed',
      'policy-storage',
      'invalid local setup state',
      (request: Request): unknown =>
        request.type === 'clearFocusLockData'
          ? { ok: false, error: 'remote removal unavailable', scope: 'all', status: 'pending' }
          : undefined,
    );
    const { getByRole } = render(h(App, null));

    const first: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: DELETE_ALL_LABEL }) as HTMLButtonElement,
    );
    fireEvent.click(first);
    fireEvent.click(getByRole('button', { name: DELETE_CONFIRM_LABEL }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('remote removal unavailable');
    });
    expect(getByRole('heading', { name: BOOT_FAILED_HEADING })).toBeTruthy();
  });

  it('adds Reset local runtime only for runtime-boot-failed', async (): Promise<void> => {
    let reset: boolean = false;
    installBootFailure(
      'runtime-boot-failed',
      'runtime',
      'the runtime migration checkpoint survived its removal',
      (request: Request): unknown => {
        if (request.type !== 'resetLocalRuntime') return undefined;
        reset = true;
        return { ok: true };
      },
    );
    const { getByRole, getByText } = render(h(App, null));

    const resetButton: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        getByRole('button', { name: RESET_RUNTIME_LABEL }) as HTMLButtonElement,
    );
    expect(
      getByText('Keeps your settings, lists, and statistics. Clears the current session state.'),
    ).toBeTruthy();
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy();

    fireEvent.click(resetButton);

    await waitFor((): void => {
      expect(getByRole('button', { name: START_BUTTON })).toBeTruthy();
    });
    expect(reset).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'resetLocalRuntime' });
  });

  it('re-reads setup after a successful Retry', async (): Promise<void> => {
    installBootFailure('boot-failed', 'policy-storage', 'invalid local setup state');
    const { getByRole, queryByRole } = render(h(App, null));

    const retry: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: 'Retry' }) as HTMLButtonElement,
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith({ type: 'retryBoot' });

    fireEvent.click(retry);

    // The worker is running now: the setup record and the snapshot are read again and the form
    // replaces the failure screen without a reload.
    await waitFor((): void => {
      expect(getByRole('button', { name: START_BUTTON })).toBeTruthy();
    });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'retryBoot' });
    expect(queryByRole('heading', { name: BOOT_FAILED_HEADING })).toBeNull();
  });

  it('shows the worker rejection when Retry fails again', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') {
        return { ...COMPLETED_SETUP, storageError: 'boot-failed' };
      }
      if (request.type === 'getBootFailure') {
        return {
          ok: true,
          failure: { stage: 'policy-storage', message: 'invalid local setup state', at: NOW },
        };
      }
      if (request.type === 'retryBoot') {
        return {
          ok: false,
          error: 'Focus Lock did not finish starting: invalid local setup state',
        };
      }
      return { ok: false, error: 'Focus Lock did not finish starting: invalid local setup state' };
    });
    const { getByRole } = render(h(App, null));

    const retry: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: 'Retry' }) as HTMLButtonElement,
    );
    fireEvent.click(retry);

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Focus Lock did not finish starting: invalid local setup state',
      );
    });
    expect(getByRole('heading', { name: BOOT_FAILED_HEADING })).toBeTruthy();
  });

  it('offers Retry when the setup status is unavailable and re-reads it', async (): Promise<void> => {
    let answering: boolean = false;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') {
        return answering ? COMPLETED_SETUP : { ok: false, error: 'invalid request' };
      }
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'getLists') return DEFAULT_LISTS;
      if (request.type === 'getStats') return STATS;
      return { ok: true };
    });
    const { getByRole, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toContain('Setup status unavailable');
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
    answering = true;

    fireEvent.click(getByRole('button', { name: 'Retry' }));

    await waitFor((): void => {
      expect(getByRole('button', { name: START_BUTTON })).toBeTruthy();
    });
    expect(queryByRole('alert')).toBeNull();
  });
});
