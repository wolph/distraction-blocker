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

function indefiniteSnap(): SessionSnapshot {
  return {
    ...focusSnap(),
    config: { ...config, durationMin: null, cycling: null },
    phaseEndsAt: null,
    sessionEndsAt: null,
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

  it('shows infinity and opens the existing cancel gate from Unlock', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(
      h(ActiveView, { snapshot: indefiniteSnap(), now: NOW }),
    );
    expect(view.container.querySelector('.clock')?.textContent).toBe('∞');
    expect(view.container.querySelector('.clock')?.getAttribute('title')).toBe(
      'Until manual unlock',
    );
    expect(view.getByText('Until manual unlock')).toBeTruthy();
    expect(view.getByRole('img', { name: 'Until manual unlock' })).toBeTruthy();
    expect(view.queryByText('0:00')).toBeNull();
    const unlock: HTMLButtonElement = view.getByRole('button', {
      name: 'Unlock',
      exact: true,
    }) as HTMLButtonElement;
    fireEvent.click(unlock);
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'openGate',
        gate: 'cancel',
        host: null,
      }),
    );
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'confirmGate' }),
    );
  });

  it('keeps indefinite Unlock confirmation gated by the configured wait and phrase', async (): Promise<void> => {
    const snapshot: SessionSnapshot = {
      ...indefiniteSnap(),
      gate: {
        kind: 'cancel',
        host: null,
        openedAt: NOW,
        readyAt: NOW + 30_000,
        requiredPhrase: 'I choose to stop',
        forceEndAvailable: false,
      },
    };
    const view: ReturnType<typeof render> = render(h(ActiveView, { snapshot, now: NOW }));
    const confirm: HTMLButtonElement = view.getByRole('button', {
      name: 'Unlock',
      exact: true,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    view.rerender(h(ActiveView, { snapshot, now: NOW + 30_000 }));
    expect(confirm.disabled).toBe(true);
    fireEvent.input(view.getByRole('textbox'), { target: { value: 'I choose to stop' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({
        type: 'confirmGate',
        typedPhrase: 'I choose to stop',
      }),
    );
  });

  it('shows finite paid access countdown while an indefinite session is paused', (): void => {
    const snapshot: SessionSnapshot = {
      ...indefiniteSnap(),
      phase: 'paused',
      phaseStartedAt: NOW - 60_000,
      phaseEndsAt: NOW + 4 * 60_000,
      bankAccrualPerMs: 0,
    };
    const view: ReturnType<typeof render> = render(h(ActiveView, { snapshot, now: NOW }));
    expect(view.getByText('4:00')).toBeTruthy();
    expect(view.getByText(/site access until/)).toBeTruthy();
    expect(view.getByRole('button', { name: 'Resume now' })).toBeTruthy();
    expect(view.queryByText('∞')).toBeNull();
  });

  it.each([
    { gate: false, hostname: 'docs.example' },
    { gate: true, hostname: 'docs.example' },
    { gate: false, hostname: undefined },
    { gate: true, hostname: undefined },
  ])(
    'shows the destination on the return button (gate=$gate, hostname=$hostname)',
    async ({ gate, hostname }: { gate: boolean; hostname: string | undefined }): Promise<void> => {
      const title: string = 'Chapter 8 - generator expressions and lazy evaluation';
      sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
        if (request.type === 'getStats') return statsBundle;
        if (request.type === 'getWorkTarget')
          return {
            ok: true,
            sessionId: 'session-one',
            state: 'ready',
            title,
            ...(hostname === undefined ? {} : { hostname }),
          };
        return { ok: true };
      });
      tabsQueryMock.mockResolvedValue([{ id: 4, windowId: 2, url: 'https://current.example' }]);
      const view: ReturnType<typeof render> = render(
        h(ActiveView, { snapshot: gate ? gateSnap() : focusSnap(), now: NOW }),
      );
      const name: string = `Back to work: ${title}${hostname === undefined ? '' : ` (${hostname})`}`;
      await waitFor((): void => expect(view.getByRole('button', { name })).toBeTruthy());
      const button: HTMLButtonElement = view.getByRole('button', { name }) as HTMLButtonElement;
      expect(button.textContent).toContain(title);
      expect(button.title).toBe(name);
      if (hostname !== undefined) expect(button.textContent).toContain(hostname);
      expect(button.textContent).not.toContain('undefined');
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      await waitFor((): void =>
        expect(sendMessageMock).toHaveBeenCalledWith({
          type: 'returnToWork',
          sessionId: 'session-one',
          windowId: 2,
        }),
      );
    },
  );

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

  it('does not activate a legacy target whose destination cannot be identified', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      if (request.type === 'getWorkTarget')
        return { ok: true, sessionId: 'session-one', state: 'ready', title: '   ' };
      return { ok: true };
    });
    tabsQueryMock.mockResolvedValue([{ id: 4, windowId: 2, url: 'https://current.example' }]);
    const view: ReturnType<typeof render> = render(
      h(ActiveView, { snapshot: focusSnap(), now: NOW }),
    );
    await waitFor((): void =>
      expect(
        view.getByRole('button', { name: 'Back to work: Destination unavailable' }),
      ).toBeTruthy(),
    );
    const button: HTMLButtonElement = view.getByRole('button', {
      name: 'Back to work: Destination unavailable',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    button.click();
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'returnToWork' }),
    );
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
    expect(getByText(/site access until/)).toBeTruthy();
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
