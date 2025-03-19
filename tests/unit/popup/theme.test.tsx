/** @vitest-environment jsdom */
import './chrome-fake';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/popup/App';
import { emptySnapshot } from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import type { SessionSnapshot } from '../../../src/shared/types';
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
  totals: { focusMsToday: 0, focusMsWeek: 0, attemptsToday: 0, resistedToday: 0 },
};

function activeSnapshot(theme: SessionSnapshot['theme'] = 'auto'): SessionSnapshot {
  return {
    ...emptySnapshot(Date.now()),
    theme,
    phase: 'focus',
    startedAt: Date.now() - 1_000,
    phaseStartedAt: Date.now() - 1_000,
    phaseEndsAt: Date.now() + 60_000,
    sessionEndsAt: Date.now() + 60_000,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 1,
      cycling: null,
      intention: 'work',
      source: 'manual',
      scheduleEntryId: null,
    },
  };
}

beforeEach((): void => {
  resetChromeFake();
  sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
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
    expect(container.querySelector('[data-icon="settings"]')).toBeTruthy();
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
