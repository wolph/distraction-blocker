/** @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import type { VNode } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Data } from '../../../src/options/Data';
import { SoundsBadge } from '../../../src/options/SoundsBadge';
import { type SettingsStore, useSettingsStore } from '../../../src/options/use-settings';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  emptySnapshot,
  rulesFromLists,
} from '../../../src/shared/constants';
import type { ListsConfig, ScheduleEntry } from '../../../src/shared/types';
import { type ChromeFake, installChromeFake } from './chrome-fake';

let fake: ChromeFake;
let captured: SettingsStore | null = null;

function Harness(): VNode {
  captured = useSettingsStore();
  return <output>{captured.settings === null ? 'loading' : 'ready'}</output>;
}

function store(): SettingsStore {
  if (captured === null) throw new Error('store not mounted');
  return captured;
}

function scheduleEntry(id: string, start: string, end: string): ScheduleEntry {
  return {
    id,
    days: [1],
    start,
    end,
    mode: 'blacklist',
    strictness: 'friction',
    cycling: null,
    intention: '',
    enabled: true,
  };
}

describe('Options runtime response boundaries', (): void => {
  beforeEach((): void => {
    captured = null;
    fake = installChromeFake();
    fake.respond('getSettings', DEFAULT_SETTINGS);
    fake.respond('getLists', DEFAULT_LISTS);
    fake.respond('getSnapshot', emptySnapshot(0));
    fake.respond('previewSound', { ok: true });
    fake.respond('exportEvents', { json: '[]' });
  });

  afterEach((): void => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each([
    ['invalid cycle', { defaultCycling: { ...DEFAULT_SETTINGS.defaultCycling, focusMin: 0 } }],
    ['invalid schedule', { schedule: [{ ...DEFAULT_SETTINGS.schedule, id: 'x' }] }],
    ['invalid economy', { pause: { ...DEFAULT_SETTINGS.pause, capMs: Number.NaN } }],
  ])('does not publish settings with %s', async (_label: string, update: object): Promise<void> => {
    fake.respond('getSettings', { ...DEFAULT_SETTINGS, ...update });
    render(<Harness />);

    await waitFor((): void => {
      expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
    });
    expect(store().settings).toBeNull();
  });

  it.each([
    [
      'duplicate schedule ids',
      [scheduleEntry('same', '09:00', '10:00'), scheduleEntry('same', '11:00', '12:00')],
    ],
    [
      'overlapping enabled schedules',
      [scheduleEntry('first', '09:00', '11:00'), scheduleEntry('second', '10:00', '12:00')],
    ],
  ])(
    'does not publish settings with %s',
    async (_label: string, schedule: ScheduleEntry[]): Promise<void> => {
      fake.respond('getSettings', { ...DEFAULT_SETTINGS, schedule });
      render(<Harness />);

      await waitFor((): void => {
        expect(store().loadError).toBe('Could not load settings. Reload the page to try again.');
      });
      expect(store().settings).toBeNull();
    },
  );

  it.each([
    ['null', null],
    ['primitive', 42],
    ['malformed', { type: 'stateChanged' }],
  ])(
    'ignores a %s broadcast envelope without losing the current snapshot',
    async (_label: string, message: unknown): Promise<void> => {
      const expectedSnapshot = emptySnapshot(0);
      render(<Harness />);
      await waitFor((): void => {
        expect(store().snapshot).toEqual(expectedSnapshot);
      });

      await act(async (): Promise<void> => {
        expect((): void => fake.emit(message)).not.toThrow();
      });

      expect(store().snapshot).toEqual(expectedSnapshot);
    },
  );

  it('preserves a hard-session banner after a malformed snapshot broadcast', async (): Promise<void> => {
    const sessionEndsAt: number = new Date(2026, 7, 28, 16, 45).getTime();
    const hardSnapshot = {
      ...emptySnapshot(sessionEndsAt - 15 * 60_000),
      phase: 'focus' as const,
      config: {
        mode: 'blacklist' as const,
        strictness: 'hard' as const,
        durationMin: 25,
        cycling: null,
        intention: 'report',
        source: 'manual' as const,
        scheduleEntryId: null,
        rules: rulesFromLists(DEFAULT_LISTS),
      },
      startedAt: sessionEndsAt - 15 * 60_000,
      phaseStartedAt: sessionEndsAt - 15 * 60_000,
      phaseEndsAt: sessionEndsAt,
      sessionEndsAt,
    };
    fake.respond('getSnapshot', hardSnapshot);
    const { getByText } = render(<Harness />);
    await waitFor((): void => {
      expect(store().snapshot?.config?.strictness).toBe('hard');
    });

    await act(async (): Promise<void> => {
      fake.emit({
        type: 'stateChanged',
        snapshot: { ...emptySnapshot(sessionEndsAt), attemptsToday: null },
      });
    });

    expect(store().snapshot?.config?.strictness).toBe('hard');
    expect(getByText('ready')).toBeTruthy();
  });

  it('does not commit settings after a malformed save acknowledgement', async (): Promise<void> => {
    fake.respond('updateSettings', { ok: true, error: 'not a literal success' });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().settings).toEqual(DEFAULT_SETTINGS);
    });
    let result: string | null = null;

    await act(async (): Promise<void> => {
      result = await store().saveSettings({
        section: 'notifications',
        value: {
          sounds: DEFAULT_SETTINGS.sounds,
          badgeCountdown: false,
          sessionCompleteNotification: DEFAULT_SETTINGS.sessionCompleteNotification,
        },
      });
    });

    expect(result).toBe('Could not save settings. Reload the page and try again.');
    expect(store().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('does not commit lists after a malformed save acknowledgement', async (): Promise<void> => {
    fake.respond('updateLists', { ok: 1 });
    render(<Harness />);
    await waitFor((): void => {
      expect(store().lists).toEqual(DEFAULT_LISTS);
    });
    const next: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
    };
    let result: string | null = null;

    await act(async (): Promise<void> => {
      result = await store().saveLists(next);
    });

    expect(result).toBe('Could not save lists. Reload the page and try again.');
    expect(store().lists).toEqual(DEFAULT_LISTS);
  });

  it('shows a stable error for a malformed sound preview acknowledgement', async (): Promise<void> => {
    fake.respond('previewSound', { ok: false, error: 42 });
    const { getByRole } = render(
      <SoundsBadge settings={DEFAULT_SETTINGS} onChange={(): void => {}} />,
    );

    fireEvent.click(getByRole('button', { name: 'Preview Session complete' }));

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe('Could not preview the sound. Try again.');
    });
  });

  it.each([
    ['non-array root', '{"events":[]}'],
    ['malformed event', '[{"t":"attempt","at":1}]'],
  ])(
    'does not download an export with a %s',
    async (_label: string, json: string): Promise<void> => {
      const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:test');
      Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectURL });
      Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
      fake.respond('exportEvents', { json });
      const { getByRole } = render(<Data />);

      fireEvent.click(getByRole('button', { name: 'Export event log' }));

      await waitFor((): void => {
        expect(getByRole('alert').textContent).toBe('Could not export the event log. Try again.');
      });
      expect(createObjectURL).not.toHaveBeenCalled();
    },
  );

  it('rejects a non-UUID device id with reload guidance', async (): Promise<void> => {
    fake.storageGet.mockResolvedValue({ deviceId: 'test-device-id' });
    const { getByRole } = render(<Data />);

    await waitFor((): void => {
      expect(getByRole('alert').textContent).toBe(
        'Could not load this device id. Reload the page to try again.',
      );
    });
  });
});
