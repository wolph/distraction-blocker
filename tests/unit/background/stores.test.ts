import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBank,
  loadLists,
  loadRuntime,
  loadSettings,
  loadStreak,
  mergeLists,
  mergeRuntime,
  mergeSettings,
} from '../../../src/background/stores';
import { DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import {
  LOCAL_RUNTIME,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type { StreakState } from '../../../src/shared/types';

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('storage default merging', () => {
  it('preserves nested settings defaults when stored objects are partial', () => {
    const settings = mergeSettings({
      pause: { earnRatio: 0.25 },
      gate: { delayMs: 30_000 },
      sounds: { masterVolume: 0.2 },
    });

    expect(settings.pause).toEqual({ ...DEFAULT_SETTINGS.pause, earnRatio: 0.25 });
    expect(settings.gate).toEqual({ ...DEFAULT_SETTINGS.gate, delayMs: 30_000 });
    expect(settings.sounds).toEqual({ ...DEFAULT_SETTINGS.sounds, masterVolume: 0.2 });
  });

  it('loads pending journal values before their debounced sync flush', async () => {
    const pendingStreak: StreakState = {
      current: 4,
      freezeTokens: 1,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [25, 26, 27, 28],
      activeMonth: '2026-08',
    };
    const journal: { sets: Record<string, unknown>; removes: string[] } = {
      sets: {
        [SYNC_SETTINGS]: { ...DEFAULT_SETTINGS, retentionDays: 30 },
        [SYNC_LISTS]: {
          ...DEFAULT_LISTS,
          custom: [{ kind: 'host', pattern: 'blocked.example' }],
        },
        [SYNC_BANK]: { balanceMs: 42_000 },
        [SYNC_STREAK]: pendingStreak,
      },
      removes: [],
    };
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: vi.fn(
            async (key: string): Promise<Record<string, unknown>> => ({
              [key]: undefined,
            }),
          ),
        },
      },
    });

    const [settings, lists, bank, streak] = await Promise.all([
      loadSettings(journal),
      loadLists(journal),
      loadBank(journal),
      loadStreak(journal),
    ]);

    expect(settings.retentionDays).toBe(30);
    expect(lists.custom).toEqual([{ kind: 'host', pattern: 'blocked.example' }]);
    expect(bank.balanceMs).toBe(42_000);
    expect(streak).toEqual(pendingStreak);
  });

  it('preserves category and exclusion defaults when stored lists are partial', () => {
    const lists = mergeLists({
      categories: { social: true },
      exclusions: { social: ['facebook.com'] },
    });

    expect(lists.categories).toEqual({ ...DEFAULT_LISTS.categories, social: true });
    expect(lists.exclusions).toEqual({ ...DEFAULT_LISTS.exclusions, social: ['facebook.com'] });
    expect(lists.custom).toEqual(DEFAULT_LISTS.custom);
  });
});

describe('runtime storage migration', () => {
  it('defaults missing exact economy aggregate fields to zero', () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const runtime = mergeRuntime(
      {
        date: '2026-08-29',
        todayAgg: {
          date: '2026-08-29',
          focusMs: 1,
          sessionsStarted: 0,
          sessionsCompleted: 0,
          attempts: {},
          attemptsOther: 0,
          pausesTaken: 0,
          pauseMsSpent: 0,
          unlocksTaken: 0,
          resisted: 0,
        },
      },
      now,
    );

    expect(runtime.todayAgg).toMatchObject({ pauseMsEarned: 0, unlockMsSpent: 0 });
  });

  it('drops legacy tab-id-only mute and stopped records', async () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [LOCAL_RUNTIME]: {
              stoppedTabIds: [7],
              mutedTabs: { 7: false },
            },
          }),
        },
      },
    });

    const runtime = await loadRuntime(now);

    expect(runtime).toHaveProperty('tabStates', {});
    expect(runtime).not.toHaveProperty('stoppedTabIds');
    expect(runtime).not.toHaveProperty('mutedTabs');
  });

  it('migrates URL-bound mute state and drops legacy stopped ownership', async () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [LOCAL_RUNTIME]: {
              tabStates: {
                7: {
                  url: 'https://blocked.example/page',
                  priorMuted: false,
                  stopped: true,
                },
              },
            },
          }),
        },
      },
    });

    const runtime = await loadRuntime(now);

    expect(runtime.tabStates).toEqual({
      7: {
        muteUrl: 'https://blocked.example/page',
        priorMuted: false,
        stoppedDocumentId: null,
      },
    });
  });

  it('preserves document-bound stopped ownership', async () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({
            [LOCAL_RUNTIME]: {
              tabStates: {
                7: {
                  muteUrl: null,
                  priorMuted: null,
                  stoppedDocumentId: 'document-one',
                },
              },
            },
          }),
        },
      },
    });

    const runtime = await loadRuntime(now);

    expect(runtime.tabStates).toEqual({
      7: {
        muteUrl: null,
        priorMuted: null,
        stoppedDocumentId: 'document-one',
      },
    });
  });
});
