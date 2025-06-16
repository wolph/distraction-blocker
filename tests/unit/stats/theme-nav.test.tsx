/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request, StatsBundle } from '../../../src/shared/messages';
import { App } from '../../../src/stats/App';
import { useEconomy } from '../../../src/stats/use-stats';

const BUNDLE: StatsBundle = {
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

type Listener = (message: unknown) => void;
const listeners: Set<Listener> = new Set<Listener>();
const sent: Request[] = [];
let themeResponse: unknown = { ok: true };
let settingsResponse: unknown = DEFAULT_SETTINGS;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (): void => {};
  const promise: Promise<T> = new Promise<T>((done: (value: T) => void): void => {
    resolve = done;
  });
  return { promise, resolve };
}

function EconomyProbe(): VNode {
  const { economy, theme } = useEconomy();
  return <output>{`${theme ?? 'loading'}:${economy.pauseMs}`}</output>;
}

beforeEach((): void => {
  sent.length = 0;
  listeners.clear();
  themeResponse = { ok: true };
  settingsResponse = DEFAULT_SETTINGS;
  vi.stubGlobal('chrome', {
    runtime: {
      sendMessage: async (request: Request): Promise<unknown> => {
        sent.push(request);
        if (request.type === 'getStats') return BUNDLE;
        if (request.type === 'getSettings') return settingsResponse;
        if (request.type === 'exportEvents') return { json: '[]' };
        if (request.type === 'updateTheme') return themeResponse;
        return { ok: true };
      },
      onMessage: {
        addListener: (listener: Listener): void => {
          listeners.add(listener);
        },
        removeListener: (listener: Listener): void => {
          listeners.delete(listener);
        },
      },
    },
  });
});

afterEach((): void => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Stats theme and navigation', (): void => {
  it('renders the shared menu and loads settings exactly once', async (): Promise<void> => {
    const { getByRole } = render(<App />);
    await waitFor((): void => expect(getByRole('link', { name: 'Overview' })).toBeTruthy());
    expect(getByRole('link', { name: 'Overview' }).getAttribute('aria-current')).toBe('page');
    expect(getByRole('link', { name: 'Blocking' }).getAttribute('href')).toBe(
      '../options/options.html#blocking',
    );
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(sent.filter((request: Request): boolean => request.type === 'getSettings')).toHaveLength(
      1,
    );
  });

  it('cycles theme, applies accepted state, and follows live theme updates', async (): Promise<void> => {
    const { getByRole, container } = render(<App />);
    const theme: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement =>
        getByRole('button', { name: /Theme: Auto.*Switch to Light/i }) as HTMLButtonElement,
    );
    fireEvent.click(theme);
    await waitFor((): void => expect(sent).toContainEqual({ type: 'updateTheme', theme: 'light' }));
    await waitFor((): void => expect(document.documentElement.dataset.theme).toBe('light'));

    for (const listener of listeners) {
      listener({ type: 'stateChanged', snapshot: { ...emptySnapshot(0), theme: 'dark' } });
    }
    await waitFor((): void =>
      expect(container.querySelector('[data-icon="theme-dark"]')).toBeTruthy(),
    );
  });

  it('keeps a newer broadcast theme when settings resolve later', async (): Promise<void> => {
    const settings: Deferred<typeof DEFAULT_SETTINGS> = deferred<typeof DEFAULT_SETTINGS>();
    settingsResponse = settings.promise;
    const { getByRole } = render(<EconomyProbe />);
    await waitFor((): void =>
      expect(sent.some((request: Request): boolean => request.type === 'getSettings')).toBe(true),
    );
    for (const listener of listeners) {
      listener({ type: 'stateChanged', snapshot: { ...emptySnapshot(0), theme: 'dark' } });
    }
    settings.resolve({
      ...DEFAULT_SETTINGS,
      pause: { ...DEFAULT_SETTINGS.pause, pauseMs: 9 * 60_000 },
    });
    await waitFor((): void => expect(getByRole('status').textContent).toBe('dark:540000'));
  });

  it('keeps the theme and reports an exact rejected update', async (): Promise<void> => {
    themeResponse = { ok: false, error: 'theme write rejected' };
    const { getByRole, container } = render(<App />);
    const theme: HTMLButtonElement = await waitFor(
      (): HTMLButtonElement => getByRole('button', { name: /Theme:/i }) as HTMLButtonElement,
    );
    fireEvent.click(theme);
    await waitFor((): void => expect(getByRole('alert').textContent).toBe('theme write rejected'));
    expect(container.querySelector('[data-icon="theme-auto"]')).toBeTruthy();
  });
});
