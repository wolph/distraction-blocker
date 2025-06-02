/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveView } from '../../../src/popup/ActiveView';
import { App } from '../../../src/popup/App';
import { StartForm } from '../../../src/popup/StartForm';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Ack, Request, StatsBundle } from '../../../src/shared/messages';
import type {
  GateState,
  SessionConfig,
  SessionSnapshot,
  SetupState,
} from '../../../src/shared/types';
import {
  openOptionsPageMock,
  resetChromeFake,
  sendMessageMock,
  tabsCreateMock,
  tabsQueryMock,
} from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const COMPLETED_SETUP: SetupState = {
  ...DEFAULT_SETUP,
  completed: true,
  storageMode: 'local',
  websiteAccess: 'granted',
  blockingRegistration: 'ready',
};

interface Deferred<T> {
  promise: Promise<T>;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let reject: (reason?: unknown) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>((_resolve, rejectPromise): void => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

const config: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 50,
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write the report',
  source: 'manual',
  scheduleEntryId: null,
  rules: rulesFromLists(DEFAULT_LISTS),
};

function focusSnapshot(): SessionSnapshot {
  return {
    ...emptySnapshot(NOW),
    phase: 'focus',
    config,
    startedAt: NOW - 5 * 60_000,
    phaseStartedAt: NOW - 5 * 60_000,
    phaseEndsAt: NOW + 20 * 60_000,
    sessionEndsAt: NOW + 45 * 60_000,
    bankMs: 10 * 60_000,
    bankAccrualPerMs: 5 / 30,
  };
}

function pausedSnapshot(): SessionSnapshot {
  return {
    ...focusSnapshot(),
    phase: 'paused',
    phaseStartedAt: NOW - 60_000,
    phaseEndsAt: NOW + 4 * 60_000,
  };
}

function gateSnapshot(): SessionSnapshot {
  const gate: GateState = {
    kind: 'pause',
    host: null,
    openedAt: NOW - 2_000,
    readyAt: NOW + 8_000,
    requiredPhrase: null,
    forceEndAvailable: false,
  };
  return { ...focusSnapshot(), gate };
}

const statsBundle: StatsBundle = {
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
  totals: { focusMsToday: 0, focusMsWeek: 0, attemptsToday: 0, resistedToday: 0 },
};

describe('popup request errors', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    tabsQueryMock.mockResolvedValue([{ url: 'https://www.youtube.com/watch?v=1' }]);
  });

  afterEach((): void => {
    cleanup();
  });

  it('settles rejected idle-form loading with defaults and readable feedback', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return COMPLETED_SETUP;
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') throw new Error('worker disconnected');
      if (request.type === 'getLists') return DEFAULT_LISTS;
      return { ok: true };
    });
    const { getByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('button', { name: /^Start 25 min/ })).toBeTruthy();
      expect(getByRole('alert').textContent).toBe(
        'Could not load session settings. Reload the popup to try again. Defaults are shown.',
      );
    });
  });

  it('settles a rejected start request and allows retry', async (): Promise<void> => {
    const pending: Deferred<Ack> = deferred<Ack>();
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'startSession') return pending.promise;
      return { ok: true };
    });
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    const start: HTMLButtonElement = getByRole('button', {
      name: /^Start 25 min/,
    }) as HTMLButtonElement;

    fireEvent.click(start);
    expect(start.disabled).toBe(true);
    pending.reject(new Error('worker disconnected'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not start the session. Try again.');
      expect(start.disabled).toBe(false);
    });
  });

  it('reports a rejected focused-today request without an unhandled rejection', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') throw new Error('worker disconnected');
      return { ok: true };
    });
    const { getByRole } = render(h(ActiveView, { snapshot: focusSnapshot(), now: NOW }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe("Today's focus total is unavailable.");
    });
  });

  it('reports a rejected active-tab request', async (): Promise<void> => {
    tabsQueryMock.mockRejectedValue(new Error('tabs unavailable'));
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      return { ok: true };
    });

    const { getByRole } = render(h(ActiveView, { snapshot: focusSnapshot(), now: NOW }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not identify the active site.');
    });
  });

  it('settles a rejected Statistics navigation request and allows retry', async (): Promise<void> => {
    const pending: Deferred<unknown> = deferred<unknown>();
    tabsCreateMock.mockReturnValue(pending.promise);
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return COMPLETED_SETUP;
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'getLists') return DEFAULT_LISTS;
      return { ok: true };
    });
    const { getByRole } = render(h(App, null));
    const statistics: HTMLButtonElement = getByRole('button', {
      name: 'Statistics',
    }) as HTMLButtonElement;

    fireEvent.click(statistics);
    expect(statistics.disabled).toBe(true);
    pending.reject(new Error('tabs unavailable'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not open Statistics. Try again.');
      expect(statistics.disabled).toBe(false);
    });
  });

  it('settles a rejected Options navigation request and allows retry', async (): Promise<void> => {
    const pending: Deferred<void> = deferred<void>();
    openOptionsPageMock.mockReturnValue(pending.promise);
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return COMPLETED_SETUP;
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'getLists') return DEFAULT_LISTS;
      return { ok: true };
    });
    const { getByRole } = render(h(App, null));
    const options: HTMLButtonElement = getByRole('button', {
      name: 'Options',
    }) as HTMLButtonElement;

    fireEvent.click(options);
    expect(options.disabled).toBe(true);
    pending.reject(new Error('options unavailable'));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not open Options. Try again.');
      expect(options.disabled).toBe(false);
    });
  });

  it.each([
    ['openGate' as const, focusSnapshot(), /Pause everything 5 min/],
    ['resumeFromPause' as const, pausedSnapshot(), 'Resume now'],
  ])(
    'settles a rejected %s action and allows retry',
    async (requestType: 'openGate' | 'resumeFromPause', snapshot: SessionSnapshot, buttonName:
      | string
      | RegExp): Promise<void> => {
      const pending: Deferred<Ack> = deferred<Ack>();
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return statsBundle;
        if (request.type === requestType) return pending.promise;
        return { ok: true };
      });
      const { getByRole } = render(h(ActiveView, { snapshot, now: NOW }));
      const action: HTMLButtonElement = getByRole('button', {
        name: buttonName,
      }) as HTMLButtonElement;

      fireEvent.click(action);
      expect(action.disabled).toBe(true);
      pending.reject(new Error('worker disconnected'));

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe('Could not request that action. Try again.');
        expect(action.disabled).toBe(false);
      });
    },
  );

  it.each([
    ['abandonGate' as const, 'Never mind, back to work'],
    ['confirmGate' as const, 'Take the pause'],
  ])(
    'settles a rejected %s request and allows retry',
    async (requestType: 'abandonGate' | 'confirmGate', buttonName: string): Promise<void> => {
      const pending: Deferred<Ack> = deferred<Ack>();
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return statsBundle;
        if (request.type === requestType) return pending.promise;
        return { ok: true };
      });
      const { getByRole } = render(h(ActiveView, { snapshot: gateSnapshot(), now: NOW + 9_000 }));
      const action: HTMLButtonElement = getByRole('button', {
        name: buttonName,
      }) as HTMLButtonElement;

      fireEvent.click(action);
      expect(action.disabled).toBe(true);
      pending.reject(new Error('worker disconnected'));

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe('Could not update the gate. Try again.');
        expect(action.disabled).toBe(false);
      });
    },
  );
});
