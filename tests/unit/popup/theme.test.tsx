/** @vitest-environment jsdom */
import './chrome-fake';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import {
  DEFAULT_LISTS,
  DEFAULT_SETUP,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import type { SessionSnapshot, SetupState } from '../../../src/shared/types';
import { emitMessage, openOptionsPageMock, resetChromeFake, sendMessageMock } from './chrome-fake';

const stats: StatsBundle = {
  days: [],
  months: [],
  recentSessions: [],
  streak: {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: '2026-08',
  },
  totals: { focusMsToday: 0, focusMsLast7Days: 0, attemptsToday: 0, resistedToday: 0 },
};
const COMPLETED_SETUP: SetupState = {
  ...DEFAULT_SETUP,
  completed: true,
  storageMode: 'local',
  websiteAccess: 'granted',
  blockingRegistration: 'ready',
};

function activeSnapshot(theme: SessionSnapshot['theme'] = 'auto'): SessionSnapshot {
  // One clock read: the v2 validator ties the end to the start exactly.
  const at: number = Date.now();
  const startedAt: number = at - 1_000;
  return {
    ...emptySnapshot(at),
    theme,
    lifecycle: {
      kind: 'active',
      // Friction reaches its End through the cancel gate, so no gate is open yet.
      endAuthority: {
        kind: 'friction-gate',
        gate: null,
        copy: { actionLabel: 'End session' },
        actions: { open: 'open-end-gate' },
      },
    },
    phase: 'focus',
    startedAt,
    phaseStartedAt: startedAt,
    phaseEndsAt: startedAt + 60_000,
    sessionEndsAt: startedAt + 60_000,
    sessionFocusedMs: at - startedAt,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      duration: { kind: 'timed', minutes: 1 },
      cycling: null,
      intention: 'work',
      source: 'manual',
      scheduleOccurrence: null,
      rules: rulesFromLists(DEFAULT_LISTS),
    },
  };
}

beforeEach((): void => {
  resetChromeFake();
  sessionStorage.clear();
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
    if (request.type === 'getSetupState') return COMPLETED_SETUP;
    if (request.type === 'getSnapshot') return activeSnapshot();
    if (request.type === 'getStats') return stats;
    return { ok: true };
  });
});

afterEach((): void => cleanup());

describe('popup theme application', (): void => {
  it('keeps only Settings in the header and makes no statistics request', async (): Promise<void> => {
    const view: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => expect(document.documentElement.dataset.theme).toBe('auto'));
    const header: HTMLElement = view.container.querySelector('header') as HTMLElement;
    expect(header.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(view.getByRole('button', { name: 'Settings' }));
    expect(openOptionsPageMock).toHaveBeenCalledOnce();
    expect(view.queryByRole('button', { name: 'Statistics' })).toBeNull();
    expect(view.queryByRole('button', { name: /Theme:/ })).toBeNull();
    expect(sendMessageMock).not.toHaveBeenCalledWith({ type: 'getStats', days: 1 });
  });

  it('follows live light, dark and auto snapshot themes without a header control', async (): Promise<void> => {
    render(<App />);
    await waitFor((): void => expect(document.documentElement.dataset.theme).toBe('auto'));
    for (const theme of ['dark', 'light', 'auto'] as const) {
      emitMessage({ type: 'stateChanged', snapshot: activeSnapshot(theme) });
      await waitFor((): void => expect(document.documentElement.dataset.theme).toBe(theme));
    }
  });
});
