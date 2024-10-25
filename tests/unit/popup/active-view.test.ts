/** @vitest-environment jsdom */
import './chrome-fake';

import { cleanup, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveView } from '../../../src/popup/ActiveView';
import { DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import type { GateState, SessionConfig, SessionSnapshot } from '../../../src/shared/types';
import { resetChromeFake, sendMessageMock, tabsQueryMock } from './chrome-fake';

const NOW: number = 1_700_000_000_000;

const config: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 50,
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write the report',
  source: 'manual',
  scheduleEntryId: null,
};

function focusSnap(): SessionSnapshot {
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

function gateSnap(): SessionSnapshot {
  const gate: GateState = {
    kind: 'pause',
    host: null,
    openedAt: NOW - 2_000,
    readyAt: NOW + 8_000,
    requiredPhrase: null,
  };
  return { ...focusSnap(), gate };
}

function pausedSnap(): SessionSnapshot {
  return {
    ...focusSnap(),
    phase: 'paused',
    phaseStartedAt: NOW - 60_000,
    phaseEndsAt: NOW + 4 * 60_000,
  };
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
  totals: { focusMsToday: 52 * 60_000, focusMsWeek: 0, attemptsToday: 0, resistedToday: 0 },
};

describe('ActiveView', () => {
  beforeEach((): void => {
    resetChromeFake();
    sendMessageMock.mockImplementation(async (req: Request): Promise<unknown> => {
      if (req.type === 'getStats') return statsBundle;
      return { ok: true };
    });
    tabsQueryMock.mockResolvedValue([{ url: 'https://www.youtube.com/watch?v=1' }]);
  });

  afterEach((): void => {
    cleanup();
  });

  it('renders the clock, both spend buttons, and the friction cancel', async (): Promise<void> => {
    const { getByText, getByRole } = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));

    expect(getByText('20:00')).toBeTruthy();
    expect(getByText('focusing')).toBeTruthy();
    expect(getByRole('button', { name: /Unlock this site/ })).toBeTruthy();
    expect(getByRole('button', { name: /Pause everything/ })).toBeTruthy();
    expect(getByRole('button', { name: /End session early/ })).toBeTruthy();
    await waitFor((): void => {
      expect(getByText('52 min focused today')).toBeTruthy();
    });
  });

  it('hides the friction cancel for hard sessions', (): void => {
    const hard: SessionSnapshot = {
      ...focusSnap(),
      config: { ...config, strictness: 'hard' },
    };
    const { queryByRole } = render(h(ActiveView, { snapshot: hard, now: NOW }));
    expect(queryByRole('button', { name: /End session early/ })).toBeNull();
  });

  it('renders the gate with back-to-work as the only enabled button before readyAt', (): void => {
    const { container, getByRole } = render(h(ActiveView, { snapshot: gateSnap(), now: NOW }));

    const backToWork: HTMLButtonElement = getByRole('button', {
      name: 'Never mind, back to work',
    }) as HTMLButtonElement;
    expect(backToWork.disabled).toBe(false);

    const buttons: HTMLButtonElement[] = Array.from(container.querySelectorAll('button'));
    for (const button of buttons) {
      if (button !== backToWork) expect(button.disabled).toBe(true);
    }
  });

  it('enables the gate confirm once readyAt has passed', (): void => {
    const { getByRole } = render(h(ActiveView, { snapshot: gateSnap(), now: NOW + 9_000 }));
    const confirm: HTMLButtonElement = getByRole('button', {
      name: 'Take the pause',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('renders paused state with a resume button', (): void => {
    const { getByRole, getByText } = render(h(ActiveView, { snapshot: pausedSnap(), now: NOW }));
    expect(getByRole('button', { name: 'Resume now' })).toBeTruthy();
    expect(getByText(/paused, back at/)).toBeTruthy();
  });
});
