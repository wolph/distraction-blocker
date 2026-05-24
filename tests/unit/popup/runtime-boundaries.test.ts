/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveView } from '../../../src/popup/ActiveView';
import { App } from '../../../src/popup/App';
import { GatePanel } from '../../../src/popup/GatePanel';
import { StartForm } from '../../../src/popup/StartForm';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import {
  MAX_RELATIVE_DURATION_MS,
  MAX_RELATIVE_MINUTES,
} from '../../../src/shared/numeric-validation';
import { isSessionSnapshot, isSettings } from '../../../src/shared/runtime-validation';
import type {
  CycleConfig,
  GateState,
  ScheduleEntry,
  SessionConfig,
  SessionSnapshot,
  Settings,
} from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;
const CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write report',
  source: 'manual',
  scheduleEntryId: null,
};
const SCHEDULE_ENTRY: ScheduleEntry = {
  id: 'schedule-entry',
  days: [1],
  start: '09:00',
  end: '10:00',
  mode: 'blacklist',
  strictness: 'friction',
  cycling: null,
  intention: '',
  enabled: true,
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
  totals: { focusMsToday: 0, focusMsWeek: 0, attemptsToday: 0, resistedToday: 0 },
};

function activeSnapshot(phase: 'focus' | 'break' | 'paused'): SessionSnapshot {
  return {
    ...emptySnapshot(NOW),
    phase,
    config: CONFIG,
    startedAt: NOW - 10 * 60_000,
    phaseStartedAt: NOW - 5 * 60_000,
    phaseEndsAt: NOW + 20 * 60_000,
    sessionEndsAt: NOW + 45 * 60_000,
    bankMs: 10 * 60_000,
    bankAccrualPerMs: phase === 'focus' ? 5 / 30 : 0,
  };
}

describe('popup runtime response boundaries', (): void => {
  beforeEach((): void => {
    resetChromeFake();
    tabsQueryMock.mockResolvedValue([{ url: 'https://example.com/' }]);
  });

  afterEach((): void => {
    cleanup();
  });

  it('disables fallback categories so a failed list load cannot overwrite worker lists', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'getLists') return { ...DEFAULT_LISTS, categories: null };
      if (request.type === 'startSession')
        return { ok: false, error: 'authoritative start failure' };
      return { ok: true };
    });
    const { getByRole, getByText } = render(h(App, null));

    const social: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: 'Social media' }) as HTMLButtonElement,
    );
    expect(social.disabled).toBe(true);
    expect(getByRole('alert').textContent).toMatch(/reload the popup.*categor/i);

    fireEvent.click(social);
    expect(
      sendMessageMock.mock.calls.some(
        (call: unknown[]): boolean => (call[0] as Request | undefined)?.type === 'updateLists',
      ),
    ).toBe(false);

    fireEvent.click(getByRole('button', { name: 'Start focusing' }));
    await waitFor((): void => {
      expect(getByText('authoritative start failure')).toBeTruthy();
    });
  });

  it('renders fallback settings instead of crashing on a malformed nested cycle', async (): Promise<void> => {
    const malformed: unknown = { ...DEFAULT_SETTINGS, defaultCycling: null };
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSnapshot') return emptySnapshot(NOW);
      if (request.type === 'getSettings') return malformed;
      if (request.type === 'getLists') return DEFAULT_LISTS;
      return { ok: true };
    });
    const { getByRole } = render(h(App, null));

    await waitFor((): void => {
      expect(getByRole('button', { name: 'Start focusing' })).toBeTruthy();
      expect(getByRole('alert').textContent).toMatch(/reload the popup/i);
    });
  });

  it('accepts worker-valid fractional and maximum cycle durations', (): void => {
    const cycles: CycleConfig[] = [
      { focusMin: 0.25, shortBreakMin: 0.05, longBreakMin: 1.25, longEvery: 4 },
      {
        focusMin: MAX_RELATIVE_MINUTES,
        shortBreakMin: MAX_RELATIVE_MINUTES,
        longBreakMin: MAX_RELATIVE_MINUTES,
        longEvery: 4,
      },
    ];

    for (const cycling of cycles) {
      const settings: Settings = { ...DEFAULT_SETTINGS, defaultCycling: cycling };
      const snapshot: SessionSnapshot = {
        ...activeSnapshot('focus'),
        config: { ...CONFIG, cycling },
      };

      expect(isSettings(settings)).toBe(true);
      expect(isSessionSnapshot(snapshot)).toBe(true);
    }
  });

  it('rejects a sparse schedule without throwing', (): void => {
    const schedule: ScheduleEntry[] = new Array<ScheduleEntry>(1);
    const settings: Settings = { ...DEFAULT_SETTINGS, schedule };

    expect((): boolean => isSettings(settings)).not.toThrow();
    expect(isSettings(settings)).toBe(false);
  });

  it.each([
    ['fractional streak goal', { ...DEFAULT_SETTINGS, streakGoalMin: 0.5 }],
    [
      'pause cap above relative-duration range',
      {
        ...DEFAULT_SETTINGS,
        pause: { ...DEFAULT_SETTINGS.pause, capMs: MAX_RELATIVE_DURATION_MS + 1 },
      },
    ],
    [
      'maximum safe pause cap',
      {
        ...DEFAULT_SETTINGS,
        pause: { ...DEFAULT_SETTINGS.pause, capMs: Number.MAX_SAFE_INTEGER },
      },
    ],
    [
      'zero pause length',
      { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, pauseMs: 0 } },
    ],
    [
      'zero unlock length',
      { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, unlockMs: 0 } },
    ],
  ])('accepts worker-valid settings with %s', (_label: string, settings: Settings): void => {
    expect(isSettings(settings)).toBe(true);
  });

  it.each([
    ['bank cap above relative-duration range', { bankCapMs: MAX_RELATIVE_DURATION_MS + 1 }],
    ['maximum safe bank cap', { bankCapMs: Number.MAX_SAFE_INTEGER }],
    ['zero pause cost', { pauseCostMs: 0 }],
    ['zero unlock cost', { unlockCostMs: 0 }],
  ])(
    'accepts a worker-authoritative snapshot with %s',
    (_label: string, override: Partial<SessionSnapshot>): void => {
      expect(isSessionSnapshot({ ...activeSnapshot('focus'), ...override })).toBe(true);
    },
  );

  it('rejects sparse preset minutes without throwing', (): void => {
    const presetsMin: Settings['presetsMin'] = new Array<number>(3) as Settings['presetsMin'];
    presetsMin[0] = 15;
    presetsMin[2] = 50;
    const settings: Settings = { ...DEFAULT_SETTINGS, presetsMin };

    expect((): boolean => isSettings(settings)).not.toThrow();
    expect(isSettings(settings)).toBe(false);
  });

  it('rejects sparse schedule days without throwing', (): void => {
    const days: number[] = new Array<number>(2);
    days[0] = 1;
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      schedule: [{ ...SCHEDULE_ENTRY, days }],
    };

    expect((): boolean => isSettings(settings)).not.toThrow();
    expect(isSettings(settings)).toBe(false);
  });

  it.each([
    ['top-level settings', { ...DEFAULT_SETTINGS, extra: true }],
    [
      'cycle config',
      { ...DEFAULT_SETTINGS, defaultCycling: { ...DEFAULT_SETTINGS.defaultCycling, extra: true } },
    ],
    ['pause settings', { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, extra: true } }],
    ['gate settings', { ...DEFAULT_SETTINGS, gate: { ...DEFAULT_SETTINGS.gate, extra: true } }],
    [
      'sound settings',
      { ...DEFAULT_SETTINGS, sounds: { ...DEFAULT_SETTINGS.sounds, extra: true } },
    ],
    ['schedule entry', { ...DEFAULT_SETTINGS, schedule: [{ ...SCHEDULE_ENTRY, extra: true }] }],
  ])('rejects extra keys in %s', (_label: string, settings: unknown): void => {
    expect(isSettings(settings)).toBe(false);
  });

  it('treats a malformed start acknowledgement as an error', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, error: 'not a literal success' });
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );

    fireEvent.click(getByRole('button', { name: 'Start focusing' }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not start session. Try again.');
    });
  });

  it('does not commit a category change after a malformed acknowledgement', async (): Promise<void> => {
    sendMessageMock.mockResolvedValue({ ok: true, error: 'not a literal success' });
    const { getByRole } = render(
      h(StartForm, { settings: DEFAULT_SETTINGS, lists: DEFAULT_LISTS }),
    );
    const social: HTMLButtonElement = getByRole('button', {
      name: 'Social media',
    }) as HTMLButtonElement;

    fireEvent.click(social);

    await waitFor((): void => {
      expect(social.getAttribute('aria-pressed')).toBe('false');
      expect(getByRole('alert').textContent).toBe('Could not update categories. Try again.');
    });
  });

  it.each([
    ['openGate' as const, activeSnapshot('focus'), /Unlock all sites/],
    ['resumeFromPause' as const, activeSnapshot('paused'), 'Resume now'],
    ['startNextFocusEarly' as const, activeSnapshot('break'), 'Start next focus early'],
  ])(
    'treats a malformed %s acknowledgement as an error',
    async (requestType:
      | 'openGate'
      | 'resumeFromPause'
      | 'startNextFocusEarly', snapshot: SessionSnapshot, buttonName:
      | string
      | RegExp): Promise<void> => {
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return STATS;
        if (request.type === requestType) return { ok: 1 };
        return { ok: true };
      });
      const { getByRole } = render(h(ActiveView, { snapshot, now: NOW }));

      fireEvent.click(getByRole('button', { name: buttonName }));

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe('Could not request action. Try again.');
      });
    },
  );

  it.each([
    ['abandonGate' as const, 'Keep focusing'],
    ['confirmGate' as const, 'Unlock all sites'],
  ])(
    'treats a malformed %s acknowledgement as an error',
    async (requestType: 'abandonGate' | 'confirmGate', buttonName: string): Promise<void> => {
      const gate: GateState = {
        kind: 'pause',
        host: null,
        openedAt: NOW - 10_000,
        readyAt: NOW - 1,
        requiredPhrase: null,
        forceEndAvailable: false,
      };
      sendMessageMock.mockImplementation(
        async (request: Request): Promise<unknown> =>
          request.type === requestType ? { error: 'missing ok' } : { ok: true },
      );
      const { getByRole } = render(h(GatePanel, { gate, now: NOW, intention: '' }));

      fireEvent.click(getByRole('button', { name: buttonName }));

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe('Could not update the gate. Try again.');
      });
    },
  );

  it('rejects a malformed focused-today total', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') {
        return { ...STATS, totals: { ...STATS.totals, focusMsToday: Number.NaN } };
      }
      return { ok: true };
    });
    const { getByRole } = render(h(ActiveView, { snapshot: activeSnapshot('focus'), now: NOW }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe("Today's focus total is unavailable.");
    });
  });
});
