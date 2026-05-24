/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
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
    forceEndAvailable: false,
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

function breakSnap(elapsedMs: number): SessionSnapshot {
  return {
    ...focusSnap(),
    phase: 'break',
    phaseStartedAt: NOW - elapsedMs,
    phaseEndsAt: NOW + 3 * 60_000,
    bankAccrualPerMs: 0,
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

  it('renders the clock and overlay action labels in matching order', async (): Promise<void> => {
    const { container, getByText, getByRole } = render(
      h(ActiveView, { snapshot: focusSnap(), now: NOW }),
    );

    expect(getByText('20:00')).toBeTruthy();
    expect(getByText('focusing')).toBeTruthy();
    expect(container.querySelector('.phase-label-focus')).toBeTruthy();
    expect(container.querySelectorAll('circle')[1]?.getAttribute('stroke')).toBe('#22c55e');
    expect(getByRole('button', { name: /Unlock this site 5:00/ })).toBeTruthy();
    expect(getByRole('button', { name: /Unlock all sites 5:00/ })).toBeTruthy();
    expect(getByRole('button', { name: 'End session' })).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll('.actions button')).map((button: Element): string =>
        (button.querySelector('.spend-label')?.textContent ?? button.textContent ?? '').trim(),
      ),
    ).toEqual([
      'Unlock this site 5:00 - costs 5:00 credit',
      'Unlock all sites 5:00 - costs 5:00 credit',
      'End session',
    ]);
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
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('does not promise access beyond the current focus block', async (): Promise<void> => {
    const snapshot: SessionSnapshot = { ...focusSnap(), bankMs: 0 };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void =>
      expect(getAllByText('Not enough time in this focus block')).toHaveLength(2),
    );
    expect(queryByText('enough in 30:00')).toBeNull();
    expect(queryByText('ready in 30:00')).toBeNull();
  });

  it('never renders ready in zero for a positive sub-second wait', async (): Promise<void> => {
    const snapshot: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 299_900,
      bankAccrualPerMs: 1,
    };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => expect(getAllByText('Ready in 0:01')).toHaveLength(2));
    expect(queryByText('ready in 0:00')).toBeNull();
  });

  it('does not promise access above the configured credit cap', async (): Promise<void> => {
    const snapshot: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 0,
      bankCapMs: 0,
    };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void =>
      expect(getAllByText('Cost exceeds the credit limit')).toHaveLength(2),
    );
    expect(queryByText('ready in 6:00')).toBeNull();
  });

  it('uses the contrast-safe paused text token for errors', (): void => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/popup/popup.css'), 'utf8');

    expect(css).toMatch(/\.form-error\s*\{[^}]*color:\s*var\(--paused-text\)/s);
  });

  it('renders the gate with back-to-work as the only enabled button before readyAt', (): void => {
    const { container, getByRole } = render(h(ActiveView, { snapshot: gateSnap(), now: NOW }));

    const backToWork: HTMLButtonElement = getByRole('button', {
      name: 'Keep focusing',
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
      name: 'Unlock all sites',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('offers force end before timeout and sends the dedicated request', async (): Promise<void> => {
    const snapshot: SessionSnapshot = gateSnap();
    if (snapshot.gate === null) throw new Error('gate fixture must contain a gate');
    snapshot.gate = {
      ...snapshot.gate,
      kind: 'cancel',
      requiredPhrase: 'I choose to stop',
      forceEndAvailable: true,
    };
    const { getByRole } = render(h(ActiveView, { snapshot, now: NOW }));

    const forceEnd: HTMLButtonElement = getByRole('button', {
      name: 'Ignore timeout and end anyway',
    }) as HTMLButtonElement;
    expect(forceEnd.disabled).toBe(false);
    fireEvent.click(forceEnd);

    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'forceEndGate' });
    });
  });

  it.each([
    { kind: 'unlockSite' as const, label: 'Unlock this site' },
    { kind: 'cancel' as const, label: 'End the session' },
  ])('uses the overlay confirmation label for $kind', ({ kind, label }): void => {
    const gateSnapshot: SessionSnapshot = gateSnap();
    if (gateSnapshot.gate === null) throw new Error('gate fixture must contain a gate');
    const snapshot: SessionSnapshot = {
      ...gateSnapshot,
      gate: { ...gateSnapshot.gate, kind },
    };
    const { getByRole } = render(h(ActiveView, { snapshot, now: NOW + 9_000 }));

    expect(getByRole('button', { name: label })).toBeTruthy();
  });

  it('renders paused state with a resume button', (): void => {
    const { getByRole, getByText } = render(h(ActiveView, { snapshot: pausedSnap(), now: NOW }));
    expect(getByRole('button', { name: 'Resume now' })).toBeTruthy();
    expect(getByText(/paused, back at/)).toBeTruthy();
  });

  it('renders no escape controls during the first two minutes of a break', (): void => {
    const { queryByRole } = render(
      h(ActiveView, { snapshot: breakSnap(2 * 60_000 - 1), now: NOW }),
    );

    expect(queryByRole('button', { name: /Unlock this site/ })).toBeNull();
    expect(queryByRole('button', { name: /Unlock all sites/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
    expect(queryByRole('button', { name: 'Start next focus early' })).toBeNull();
  });

  it('only offers starting focus early after two minutes of a break', (): void => {
    const { getByRole, queryByRole } = render(
      h(ActiveView, { snapshot: breakSnap(2 * 60_000), now: NOW }),
    );

    expect(getByRole('button', { name: 'Start next focus early' })).toBeTruthy();
    expect(queryByRole('button', { name: /Unlock this site/ })).toBeNull();
    expect(queryByRole('button', { name: /Unlock all sites/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });
});
