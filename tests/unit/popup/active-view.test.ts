/** @vitest-environment jsdom */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import './chrome-fake';

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActiveView } from '../../../src/popup/ActiveView';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
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
  rules: rulesFromLists(DEFAULT_LISTS),
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

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  if (resolve === undefined) throw new Error('deferred resolver was not initialized');
  return { promise, resolve };
}

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
    expect(getByRole('button', { name: /Unlock this site for 5 min/ })).toBeTruthy();
    expect(getByRole('button', { name: /Pause blocking for 5 min/ })).toBeTruthy();
    expect(getByRole('button', { name: 'End session' })).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll('.actions button')).map((button: Element): string =>
        (button.querySelector('.spend-label')?.textContent ?? button.textContent ?? '').trim(),
      ),
    ).toEqual(['Unlock this site for 5 min', 'Pause blocking for 5 min', 'End session']);
    await waitFor((): void => {
      expect(getByText('52 min focused today')).toBeTruthy();
    });
  });

  it('ends Flexible sessions through the strictness-aware worker request', async (): Promise<void> => {
    const flexible: SessionSnapshot = {
      ...focusSnap(),
      config: { ...config, strictness: 'flexible' },
    };
    const { getByRole } = render(h(ActiveView, { snapshot: flexible, now: NOW }));

    fireEvent.click(getByRole('button', { name: 'End session' }));

    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'requestSessionEnd' });
    });
    expect(sendMessageMock).not.toHaveBeenCalledWith({
      type: 'openGate',
      gate: 'cancel',
      host: null,
    });
  });

  it('requests Friction cancellation through the same worker boundary', async (): Promise<void> => {
    const { getByRole } = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));

    fireEvent.click(getByRole('button', { name: 'End session' }));

    await waitFor((): void => {
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'requestSessionEnd' });
    });
  });

  it('locks every action synchronously and ignores duplicate Flexible end clicks', async (): Promise<void> => {
    const ending: Deferred<unknown> = deferred<unknown>();
    sendMessageMock.mockImplementation((request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return Promise.resolve(statsBundle);
      if (request.type === 'requestSessionEnd') return ending.promise;
      return Promise.resolve({ ok: true });
    });
    const flexible: SessionSnapshot = {
      ...focusSnap(),
      config: { ...config, strictness: 'flexible' },
    };
    const { container, getByRole } = render(h(ActiveView, { snapshot: flexible, now: NOW }));
    const end: HTMLButtonElement = getByRole('button', {
      name: 'End session',
    }) as HTMLButtonElement;

    end.click();
    end.click();

    expect(
      sendMessageMock.mock.calls.filter(
        (call: unknown[]): boolean => (call[0] as Request).type === 'requestSessionEnd',
      ),
    ).toHaveLength(1);
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>('button')).every(
        (button: HTMLButtonElement): boolean => button.disabled,
      ),
    ).toBe(true);

    ending.resolve({ ok: true });
    await waitFor((): void => expect(end.disabled).toBe(false));
  });

  it('reports active-site loading, ready, unsupported, and error states truthfully', async (): Promise<void> => {
    const lookup: Deferred<Array<{ url: string }>> = deferred<Array<{ url: string }>>();
    tabsQueryMock.mockReturnValue(lookup.promise);
    const first = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const loading: HTMLButtonElement = first.getByRole('button', {
      name: /Unlock this site for 5 min/,
    }) as HTMLButtonElement;
    expect(loading.textContent).toContain('Checking the active site');
    expect(loading.disabled).toBe(true);
    lookup.resolve([{ url: 'https://www.youtube.com/watch?v=1' }]);
    await waitFor((): void => expect(loading.textContent).toContain('youtube.com'));
    first.unmount();

    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    const unsupportedView = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const unsupported: HTMLButtonElement = unsupportedView.getByRole('button', {
      name: /Unlock this site for 5 min/,
    }) as HTMLButtonElement;
    await waitFor((): void => {
      expect(unsupported.textContent).toContain('Open a regular website to unlock it');
    });
    unsupportedView.unmount();

    tabsQueryMock.mockRejectedValue(new Error('tabs unavailable'));
    const errorView = render(h(ActiveView, { snapshot: focusSnap(), now: NOW }));
    const errored: HTMLButtonElement = errorView.getByRole('button', {
      name: /Unlock this site for 5 min/,
    }) as HTMLButtonElement;
    await waitFor((): void => {
      expect(errored.textContent).toContain('Could not identify the active site');
    });
    expect(errored.textContent).not.toContain('Open a regular website');
  });

  it('prioritizes the unsupported-tab reason over insufficient budget', async (): Promise<void> => {
    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    const snapshot: SessionSnapshot = { ...focusSnap(), bankMs: 0 };
    const { getByRole } = render(h(ActiveView, { snapshot, now: NOW }));

    const unlock: HTMLButtonElement = getByRole('button', {
      name: /Unlock this site for 5 min/,
    }) as HTMLButtonElement;
    await waitFor((): void => {
      expect(unlock.textContent).toContain('Open a regular website to unlock it');
    });
    expect(unlock.textContent).not.toContain('ready in');
    expect(unlock.disabled).toBe(true);
  });

  it('prioritizes pending action over unsupported tab and insufficient budget', async (): Promise<void> => {
    tabsQueryMock.mockResolvedValue([{ url: 'chrome://extensions/' }]);
    sendMessageMock.mockImplementation(
      (request: Request): Promise<unknown> =>
        request.type === 'getStats'
          ? Promise.resolve(statsBundle)
          : new Promise<unknown>((): void => undefined),
    );
    const snapshot: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 5 * 60_000,
      unlockCostMs: 10 * 60_000,
      pauseCostMs: 5 * 60_000,
    };
    const { getByRole } = render(h(ActiveView, { snapshot, now: NOW }));
    const pause: HTMLButtonElement = getByRole('button', {
      name: /Pause blocking for 5 min/,
    }) as HTMLButtonElement;

    fireEvent.click(pause);

    const unlock: HTMLButtonElement = getByRole('button', {
      name: /Unlock this site for 10 min/,
    }) as HTMLButtonElement;
    await waitFor((): void => {
      expect(unlock.textContent).toContain('Action in progress');
    });
    expect(unlock.textContent).not.toContain('Open a regular website');
    expect(unlock.textContent).not.toContain('ready in');
  });

  it('hides the friction cancel for hard sessions', (): void => {
    const hard: SessionSnapshot = {
      ...focusSnap(),
      config: { ...config, strictness: 'hard' },
    };
    const { queryByRole } = render(h(ActiveView, { snapshot: hard, now: NOW }));
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });

  it('shows time until the next earned pause minute while a spend is unaffordable', async (): Promise<void> => {
    const snapshot: SessionSnapshot = { ...focusSnap(), bankMs: 0 };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => expect(getAllByText('ready in 6:00')).toHaveLength(2));
    expect(queryByText('enough in 30:00')).toBeNull();
    expect(queryByText('ready in 30:00')).toBeNull();
  });

  it('never renders ready in zero for a positive sub-second wait', async (): Promise<void> => {
    const snapshot: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 59_900,
      bankAccrualPerMs: 1,
    };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => expect(getAllByText('ready in 0:01')).toHaveLength(2));
    expect(queryByText('ready in 0:00')).toBeNull();
  });

  it('does not promise an earned minute above the configured bank cap', async (): Promise<void> => {
    const snapshot: SessionSnapshot = {
      ...focusSnap(),
      bankMs: 0,
      bankCapMs: 0,
    };
    const { getAllByText, queryByText } = render(h(ActiveView, { snapshot, now: NOW }));

    await waitFor((): void => expect(getAllByText('earn pause time by focusing')).toHaveLength(2));
    expect(queryByText('ready in 6:00')).toBeNull();
  });

  it('uses the contrast-safe paused text token for errors', (): void => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/popup/popup.css'), 'utf8');

    expect(css).toMatch(/\.form-error\s*\{[^}]*color:\s*var\(--paused-text\)/s);
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

  it('renders no deliberation wait for a zero-delay gate', (): void => {
    const snapshot: SessionSnapshot = gateSnap();
    if (snapshot.gate === null) throw new Error('gate fixture must contain a gate');
    const zeroDelay: SessionSnapshot = {
      ...snapshot,
      gate: { ...snapshot.gate, openedAt: NOW, readyAt: NOW },
    };
    const { getByRole, queryByText } = render(h(ActiveView, { snapshot: zeroDelay, now: NOW }));

    expect(queryByText(/A moment to decide/)).toBeNull();
    expect((getByRole('button', { name: 'Take the pause' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('resets gate input state when the gate identity changes', (): void => {
    const first: SessionSnapshot = gateSnap();
    if (first.gate === null) throw new Error('gate fixture must contain a gate');
    const initialGate: GateState = { ...first.gate, requiredPhrase: 'first phrase' };
    const initial: SessionSnapshot = {
      ...first,
      gate: initialGate,
    };
    const view = render(h(ActiveView, { snapshot: initial, now: NOW + 9_000 }));
    const input: HTMLInputElement = view.getByRole('textbox') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'first phrase' } });
    expect(input.value).toBe('first phrase');

    const replacement: SessionSnapshot = {
      ...initial,
      gate: {
        ...initialGate,
        openedAt: initialGate.openedAt + 20_000,
        readyAt: initialGate.readyAt + 20_000,
        requiredPhrase: 'second phrase',
      },
    };
    view.rerender(h(ActiveView, { snapshot: replacement, now: NOW + 29_000 }));

    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(view.getByText('Type: second phrase')).toBeTruthy();
  });

  it('resets typed, error, and pending state when only the required phrase changes', async (): Promise<void> => {
    const pending: Deferred<unknown> = deferred<unknown>();
    let confirmationCount: number = 0;
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return statsBundle;
      if (request.type !== 'confirmGate') return { ok: true };
      confirmationCount += 1;
      return confirmationCount === 1
        ? { ok: false, error: 'The old phrase was rejected.' }
        : pending.promise;
    });
    const first: SessionSnapshot = gateSnap();
    if (first.gate === null) throw new Error('gate fixture must contain a gate');
    const initialGate: GateState = { ...first.gate, requiredPhrase: 'first phrase' };
    const initial: SessionSnapshot = { ...first, gate: initialGate };
    const view = render(h(ActiveView, { snapshot: initial, now: NOW + 9_000 }));
    const input: HTMLInputElement = view.getByRole('textbox') as HTMLInputElement;

    fireEvent.input(input, { target: { value: 'first phrase' } });
    fireEvent.click(view.getByRole('button', { name: 'Take the pause' }));
    await waitFor((): void => {
      expect(view.getByRole('alert').textContent).toBe('The old phrase was rejected.');
    });

    const second: SessionSnapshot = {
      ...initial,
      gate: { ...initialGate, requiredPhrase: 'second phrase' },
    };
    view.rerender(h(ActiveView, { snapshot: second, now: NOW + 9_000 }));

    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(view.queryByRole('alert')).toBeNull();
    expect(
      (
        view.getByRole('button', {
          name: 'Never mind, back to work',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    fireEvent.input(view.getByRole('textbox'), { target: { value: 'second phrase' } });
    fireEvent.click(view.getByRole('button', { name: 'Take the pause' }));
    expect(
      (
        view.getByRole('button', {
          name: 'Never mind, back to work',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    const third: SessionSnapshot = {
      ...initial,
      gate: { ...initialGate, requiredPhrase: 'third phrase' },
    };
    view.rerender(h(ActiveView, { snapshot: third, now: NOW + 9_000 }));

    expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('');
    expect(view.queryByRole('alert')).toBeNull();
    expect(
      (
        view.getByRole('button', {
          name: 'Never mind, back to work',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    pending.resolve({ ok: true });
  });

  it('styles disabled end-session controls as inactive', (): void => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/popup/popup.css'), 'utf8');
    expect(css).toMatch(/\.cancel-link:disabled\s*\{[^}]*cursor:\s*default/s);
    expect(css).toMatch(/\.cancel-link:disabled\s*\{[^}]*text-decoration:\s*none/s);
  });

  it('keeps disabled primary popup controls out of interactive hover styling', (): void => {
    const css: string = readFileSync(resolve(process.cwd(), 'src/popup/popup.css'), 'utf8');

    expect(css).toMatch(/\.start-button:hover:not\(:disabled\)\s*\{/);
    expect(css).toMatch(/\.start-button:disabled\s*\{[^}]*cursor:\s*default/s);
    expect(css).toMatch(/\.start-button:disabled\s*\{[^}]*opacity:\s*0\.65/s);
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
    expect(queryByRole('button', { name: /Pause blocking/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
    expect(queryByRole('button', { name: 'Start next focus early' })).toBeNull();
  });

  it('only offers starting focus early after two minutes of a break', (): void => {
    const { getByRole, queryByRole } = render(
      h(ActiveView, { snapshot: breakSnap(2 * 60_000), now: NOW }),
    );

    expect(getByRole('button', { name: 'Start next focus early' })).toBeTruthy();
    expect(queryByRole('button', { name: /Unlock this site/ })).toBeNull();
    expect(queryByRole('button', { name: /Pause blocking/ })).toBeNull();
    expect(queryByRole('button', { name: 'End session' })).toBeNull();
  });
});
