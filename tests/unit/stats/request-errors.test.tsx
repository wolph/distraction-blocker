/** @vitest-environment jsdom */
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import { App } from '../../../src/stats/App';

const bundle: StatsBundle = {
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

const sendMessageMock = vi.fn<(request: Request) => Promise<unknown>>();

describe('Stats request errors', (): void => {
  beforeEach((): void => {
    sendMessageMock.mockReset();
    vi.stubGlobal('chrome', {
      runtime: { sendMessage: sendMessageMock },
    });
  });

  afterEach((): void => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('settles a rejected stats load with readable feedback', async (): Promise<void> => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation((): void => {});
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') throw new Error('worker disconnected');
      if (request.type === 'getSettings') return DEFAULT_SETTINGS;
      if (request.type === 'exportEvents') return { json: '[]' };
      return { ok: true };
    });
    const { getByRole, queryByText } = render(<App />);

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not load stats. Reload to try again.');
    });
    expect(queryByText('Loading stats.')).toBeNull();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports partial data failures while keeping loaded stats visible', async (): Promise<void> => {
    sendMessageMock.mockImplementation(async (request: Request): Promise<unknown> => {
      if (request.type === 'getStats') return bundle;
      if (request.type === 'getSettings') throw new Error('worker disconnected');
      if (request.type === 'exportEvents') throw new Error('worker disconnected');
      return { ok: true };
    });
    const { getByRole, getByText } = render(<App />);

    await waitFor((): void => {
      expect(getByText('Stats appear after your first session.')).toBeTruthy();
      expect(getByRole('alert').textContent).toBe(
        'Hourly attempts and pause settings are unavailable.',
      );
    });
  });
});
