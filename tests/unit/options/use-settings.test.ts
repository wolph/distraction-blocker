// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../../src/options/App';
import type { SettingsStore } from '../../../src/options/use-settings';
import { useSettingsStore } from '../../../src/options/use-settings';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { ListsConfig, SessionConfig, SessionSnapshot } from '../../../src/shared/types';
import type { ChromeFake } from './chrome-fake';
import { installChromeFake } from './chrome-fake';

let fake: ChromeFake;
let captured: SettingsStore | null = null;

function Harness(): VNode {
  captured = useSettingsStore();
  return h('output', null, captured.lists === null ? 'loading' : 'ready');
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
    render(h(Harness, null));
    await waitFor((): void => {
      expect(store().lists).not.toBeNull();
    });
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
    expect(store().lists).toEqual(DEFAULT_LISTS);
    expect(store().snapshot).toEqual(emptySnapshot(0));
  });

  it('saveLists resolves null on ok and the store serves the saved lists', async (): Promise<void> => {
    fake.respond('updateLists', { ok: true });
    render(h(Harness, null));
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
    render(h(Harness, null));
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
    render(h(Harness, null));
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
    const { getByRole } = render(h(App, null));
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
    const { getByText } = render(h(App, null));
    await waitFor((): void => {
      expect(
        getByText(
          'Hard session until 16:45. Changes that weaken blocking will be rejected until then.',
        ),
      ).toBeTruthy();
    });
  });

  it('shows no banner while idle and picks up a stateChanged broadcast', async (): Promise<void> => {
    const { getByText, queryByText } = render(h(App, null));
    await waitFor((): void => {
      expect(getByText('Lists')).toBeTruthy();
    });
    const bannerText: string =
      'Hard session until 09:30. Changes that weaken blocking will be rejected until then.';
    expect(queryByText(bannerText)).toBeNull();
    const endsAt: number = new Date(2026, 7, 29, 9, 30).getTime();
    await act(async (): Promise<void> => {
      fake.emit({ type: 'stateChanged', snapshot: hardSnapshot(endsAt) });
    });
    expect(getByText(bannerText)).toBeTruthy();
  });
});
