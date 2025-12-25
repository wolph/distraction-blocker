/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  POPUP_STARTING_COPY,
  RETRY_CLEANUP_LABEL,
} from '../../../src/shared/session-copy';
import type { SessionLifecycleV2, SessionSnapshot, SetupState } from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const OPERATION_ID: string = '20000000-0000-4000-8000-000000000001';
/** A closure journal is named by the closed session's UUID plus the close suffix. */
const CLOSURE_ID: string = '10000000-0000-4000-8000-000000000001:close';
const START_BUTTON: RegExp = /^Start 25 min/;
const SETUP_HEADING: string = 'Finish setting up Focus Lock';

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

describe('popup lifecycle body', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    sessionStorage.clear();
    tabsQueryMock.mockResolvedValue([{ url: 'https://example.com/' }]);
  });

  afterEach((): void => {
    cleanup();
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

  it('renders the active view for an active lifecycle', async (): Promise<void> => {
    install(activeSnapshot(), DEFAULT_SETUP.dataClear);
    const { getByText, queryByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByText('write the report')).toBeTruthy();
    });
    expect(queryByRole('button', { name: START_BUTTON })).toBeNull();
  });
});
