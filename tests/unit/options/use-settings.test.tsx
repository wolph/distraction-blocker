/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/options/App';
import type { SettingsStore } from '../../../src/options/use-settings';
import { useSettingsStore } from '../../../src/options/use-settings';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { Request } from '../../../src/shared/messages';
import type {
  ListsConfig,
  SessionConfig,
  SessionSnapshot,
  Settings,
} from '../../../src/shared/types';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

let fake: ChromeFake;
let captured: SettingsStore | null = null;

function Harness(): VNode {
  captured = useSettingsStore();
  return <output>{captured.lists === null ? 'loading' : 'ready'}</output>;
}

function store(): SettingsStore {
  if (captured === null) throw new Error('store not mounted');
  return captured;
}

function hardSnapshot(sessionEndsAt: number): SessionSnapshot {
  const config: SessionConfig = {
    mode: 'blacklist',
    strictness: 'hard',
    durationMin: 25,
    cycling: null,
    intention: 'write the report',
    source: 'manual',
    scheduleEntryId: null,
  };
  return {
    ...emptySnapshot(sessionEndsAt - 10 * 60_000),
    phase: 'focus',
    config,
    startedAt: sessionEndsAt - 15 * 60_000,
    phaseStartedAt: sessionEndsAt - 15 * 60_000,
    phaseEndsAt: sessionEndsAt,
    sessionEndsAt,
  };
}

beforeEach((): void => {
  captured = null;
  fake = installChromeFake();
  fake.respond('getSettings', DEFAULT_SETTINGS);
  fake.respond('getLists', DEFAULT_LISTS);
  fake.respond('getSnapshot', emptySnapshot(0));
});

afterEach((): void => {
  cleanup();
});

describe('useSettingsStore', () => {
  it('loads settings, lists, and snapshot on mount', async (): Promise<void> => {
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(store().lists).toEqual(DEFAULT_LISTS);
    expect(store().snapshot).toEqual(emptySnapshot(0));
    expect(store().loadError).toBeNull();
  });

  it('rejects a malformed initial settings response without publishing it', async (): Promise<void> => {
    fake.respond('getSettings', { ok: false, error: 'worker unavailable' });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
  });

  it('rejects a worker rejection snapshot response without publishing it', async (): Promise<void> => {
    fake.respond('getSnapshot', { ok: false, error: 'worker unavailable' });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
    expect(store().snapshot).toBeNull();
  });

  it('rejects a non-positive freeze cadence from the worker', async (): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, streakFreezeIntervalDays: 0 });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
  });

  it.each([
    ['zero preset', { presetsMin: [0, 25, 50] }],
    ['sub-millisecond preset', { presetsMin: [0.000_001, 25, 50] }],
    ['unsafe preset', { presetsMin: [15, Number.MAX_SAFE_INTEGER, 50] }],
    ['preset past the relative-duration cap', { presetsMin: [15, 72_000_000_001, 50] }],
    ['maximum safe integer freeze cadence', { streakFreezeIntervalDays: Number.MAX_SAFE_INTEGER }],
    ['freeze cadence past the Date range', { streakFreezeIntervalDays: 100_000_001 }],
  ])('rejects %s from the worker', async (_label: string, update: object): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, ...update });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
  });

  it('loads fractional and exact upper-bound settings from the worker', async (): Promise<void> => {
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      presetsMin: [0.1, 25.5, 72_000_000_000],
      streakFreezeIntervalDays: 100_000_000,
    };
    fake.respond('getSettings', settings);
    render(<Harness />);

    await waitFor((): void => {
      expect(store().settings).toEqual(settings);
    });
    expect(store().loadError).toBeNull();
  });

  it('reports a rejected initial lists request without publishing partial state', async (): Promise<void> => {
    fake.respond('getLists', (): never => {
      throw new Error('worker unavailable');
    });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
    expect(store().lists).toBeNull();
  });

  it('saveLists resolves null on ok and the store serves the saved lists', async (): Promise<void> => {
    fake.respond('updateLists', { ok: true });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    const next: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'nu.nl' }],
    };
    let result: string | null = 'unset';
    await act(async (): Promise<void> => {
      result = await store().saveLists(next);
    });
    expect(result).toBeNull();
    expect(store().lists).toEqual(next);
  });

  it('saveLists resolves the rejection string verbatim and keeps the current lists', async (): Promise<void> => {
    const rejection: string = 'a hard session is running: weakening changes are locked until 16:45';
    fake.respond('updateLists', { ok: false, error: rejection });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    const next: ListsConfig = { ...DEFAULT_LISTS, custom: [] };
    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await store().saveLists(next);
    });
    expect(result).toBe(rejection);
    expect(store().lists).toEqual(DEFAULT_LISTS);
  });

  it('saveSettings mirrors the same contract', async (): Promise<void> => {
    const rejection: string = 'a hard session is running: strictness cannot be weakened';
    fake.respond('updateSettings', { ok: false, error: rejection });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().settings).not.toBeNull();
    });
    let result: string | null = null;
    await act(async (): Promise<void> => {
      result = await store().saveSettings({ ...DEFAULT_SETTINGS, streakGoalMin: 50 });
    });
    expect(result).toBe(rejection);
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('App frame', () => {
  it('renders the seven nav sections', async (): Promise<void> => {
    const { getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Lists' })).toBeTruthy();
    });
    for (const label of [
      'Lists',
      'Categories',
      'Schedule',
      'Strictness and gate',
      'Pause economy',
      'Sounds and badge',
      'Data',
    ]) {
      expect(getByRole('button', { name: label })).toBeTruthy();
    }
  });

  it('shows the hard-session banner with the end time', async (): Promise<void> => {
    const endsAt: number = new Date(2026, 7, 28, 16, 45).getTime();
    fake.respond('getSnapshot', hardSnapshot(endsAt));
    const { getByText } = render(<App />);
    await waitFor((): void => {
      expect(getByText('Changes that weaken blocking will be rejected until 16:45.')).toBeTruthy();
    });
  });

  it('shows no banner while idle and picks up a stateChanged broadcast', async (): Promise<void> => {
    const { getByText, queryByText } = render(<App />);
    await waitFor((): void => {
      expect(getByText('Lists')).toBeTruthy();
    });
    const bannerText: string = 'Changes that weaken blocking will be rejected until 09:30.';
    expect(queryByText(bannerText)).toBeNull();
    const endsAt: number = new Date(2026, 7, 29, 9, 30).getTime();
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: hardSnapshot(endsAt) });
    });
    expect(getByText(bannerText)).toBeTruthy();
  });

  it('shows a quiet load error instead of rendering malformed settings', async (): Promise<void> => {
    fake.respond('getLists', { categories: {} });
    const { getByRole, queryByText } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Could not load settings. Reload the page to try again.',
      );
    });
    expect(queryByText('Loading settings')).toBeNull();
  });

  it('saves only list fields and keeps an unsaved category weakening in the draft', async (): Promise<void> => {
    const committed: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    fake.respond('getLists', committed);
    fake.respond('updateLists', { ok: true });
    const { getAllByLabelText, getAllByRole, getByLabelText, getByRole } = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Categories' })).toBeTruthy();
    });

    fireEvent.click(getByRole('button', { name: 'Categories' }));
    fireEvent.click(getByLabelText('Social media'));
    fireEvent.click(getByRole('button', { name: 'Lists' }));
    fireEvent.input(getAllByLabelText('Pattern')[0] as HTMLElement, {
      target: { value: 'nu.nl' },
    });
    fireEvent.click(getAllByRole('button', { name: 'Add rule' })[0] as HTMLElement);
    fireEvent.click(getByRole('button', { name: 'Save lists' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateLists')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateLists' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateLists' }> =>
        request.type === 'updateLists',
    );
    expect(update?.lists.custom).toEqual([{ kind: 'host', pattern: 'nu.nl' }]);
    expect(update?.lists.categories.social).toBe(true);

    fireEvent.click(getByRole('button', { name: 'Categories' }));
    expect((getByLabelText('Social media') as HTMLInputElement).checked).toBe(false);
  });

  it('does not include an unsaved strictness weakening in a pause save', async (): Promise<void> => {
    const committed: Settings = { ...DEFAULT_SETTINGS, defaultStrictness: 'hard' };
    fake.respond('getSettings', committed);
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Strictness and gate' })).toBeTruthy();
    });

    fireEvent.click(getByRole('button', { name: 'Strictness and gate' }));
    fireEvent.click(getByLabelText('Friction: cancel costs a 30 second wait and a typed sentence'));
    fireEvent.click(getByRole('button', { name: 'Pause economy' }));
    fireEvent.input(getByLabelText('Daily streak goal (focus minutes)'), {
      target: { value: '30' },
    });
    fireEvent.click(getByRole('button', { name: 'Save pause economy' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.streakGoalMin).toBe(30);
    expect(update?.settings.defaultStrictness).toBe('hard');
  });

  it('persists preset controls through the strictness section save', async (): Promise<void> => {
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Strictness and gate' })).toBeTruthy();
    });
    fireEvent.click(getByRole('button', { name: 'Strictness and gate' }));
    fireEvent.input(getByLabelText('Short session preset (minutes)'), {
      target: { value: '12' },
    });
    fireEvent.click(getByRole('button', { name: 'Save strictness and gate' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.presetsMin).toEqual([12, 25, 50]);
  });

  it('persists freeze cadence through the pause section save', async (): Promise<void> => {
    fake.respond('getSettings', {
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: true,
    });
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Pause economy' })).toBeTruthy();
    });
    fireEvent.click(getByRole('button', { name: 'Pause economy' }));
    fireEvent.input(getByLabelText('Freeze token interval (days)'), { target: { value: '9' } });
    fireEvent.click(getByRole('button', { name: 'Save pause economy' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.streakFreezeIntervalDays).toBe(9);
  });

  it('persists notification preference through the sounds section save', async (): Promise<void> => {
    fake.respond('getSettings', {
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: true,
    });
    fake.respond('updateSettings', { ok: true });
    const { getByLabelText, getByRole }: ReturnType<typeof render> = render(<App />);
    await waitFor((): void => {
      expect(getByRole('button', { name: 'Sounds and badge' })).toBeTruthy();
    });
    fireEvent.click(getByRole('button', { name: 'Sounds and badge' }));
    fireEvent.click(getByLabelText('Show a system notification when a session completes'));
    fireEvent.click(getByRole('button', { name: 'Save sounds and badge' }));

    await waitFor((): void => {
      expect(fake.sent.some((request: Request): boolean => request.type === 'updateSettings')).toBe(
        true,
      );
    });
    const update: Extract<Request, { type: 'updateSettings' }> | undefined = fake.sent.find(
      (request: Request): request is Extract<Request, { type: 'updateSettings' }> =>
        request.type === 'updateSettings',
    );
    expect(update?.settings.sessionCompleteNotification).toBe(false);
  });
});
