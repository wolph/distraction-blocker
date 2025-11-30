/** @vitest-environment jsdom */
import './chrome-fake';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { emitMessage, resetChromeFake, sendMessageMock } from './chrome-fake';

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

describe('popup theme control', (): void => {
  it('loads the shared ThemeControl states in the popup entrypoint', (): void => {
    const source: string = readFileSync(resolve('src/popup/main.tsx'), 'utf8');
    expect(source).toContain("import '../shared/theme-control.css';");
  });

  it('cycles requests from snapshot state and uses a distinct settings cog', async (): Promise<void> => {
    const { getByRole, container } = render(<App />);
    const theme: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement = getByRole('button', {
        name: /Theme: Auto.*Switch to Light/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    expect(container.querySelector('svg.settings-cog[data-icon="settings"]')).toBeTruthy();
    fireEvent.click(theme);
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'updateTheme', theme: 'light' }),
    );
    const darkButton: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement = getByRole('button', {
        name: /Theme: Light.*Switch to Dark/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(darkButton);
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'updateTheme', theme: 'dark' }),
    );
    const autoButton: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement = getByRole('button', {
        name: /Theme: Dark.*Switch to Auto/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(autoButton);
    await waitFor((): void =>
      expect(sendMessageMock).toHaveBeenCalledWith({ type: 'updateTheme', theme: 'auto' }),
    );
  });

  it('follows a live snapshot theme', async (): Promise<void> => {
    const { container } = render(<App />);
    await waitFor((): void =>
      expect(container.querySelector('[data-icon="theme-auto"]')).toBeTruthy(),
    );
    emitMessage({ type: 'stateChanged', snapshot: activeSnapshot('dark') });
    await waitFor((): void =>
      expect(container.querySelector('[data-icon="theme-dark"]')).toBeTruthy(),
    );
    await waitFor((): void => expect(document.documentElement.dataset.theme).toBe('dark'));
  });

  it('retains the snapshot theme and reports a rejected update', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getSetupState') return COMPLETED_SETUP;
      if (request.type === 'getSnapshot') return activeSnapshot();
      if (request.type === 'getStats') return stats;
      if (request.type === 'updateTheme') return { ok: false, error: 'theme denied' };
      return { ok: true };
    });
    const { getByRole, container } = render(<App />);
    const theme: HTMLButtonElement = await waitFor((): HTMLButtonElement => {
      const button: HTMLButtonElement = getByRole('button', {
        name: /Theme:/i,
      }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      return button;
    });
    fireEvent.click(theme);
    await waitFor((): void => expect(getByRole('alert').textContent).toBe('theme denied'));
    expect(container.querySelector('[data-icon="theme-auto"]')).toBeTruthy();
  });
});
