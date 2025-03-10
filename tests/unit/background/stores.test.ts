import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import {
  appendEvents,
  loadBank,
  loadLists,
  loadMatcherCache,
  loadRuntime,
  loadSettings,
  loadStreak,
  mergeLists,
  mergeRuntime,
  mergeSettings,
  readEvents,
  saveMatcherCache,
} from '../../../src/background/stores';
import type { StoredMatcherCache } from '../../../src/core/matcher';
import { CATEGORY_IDS, DEFAULT_LISTS, DEFAULT_SETTINGS } from '../../../src/shared/constants';
import {
  LOCAL_CACHES,
  LOCAL_EVENTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_RUNTIME,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type { EventRecord, ListsConfig, Settings, StreakState } from '../../../src/shared/types';

afterEach((): void => {
  vi.unstubAllGlobals();
});

describe('list Sync storage', () => {
  it('loads a complete sharded representation', async () => {
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const lists: ListsConfig = {
      ...DEFAULT_LISTS,
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions,
    };
    const encoded = await encodeListsForSync(lists);
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: vi.fn().mockResolvedValue({}) },
        sync: { get: vi.fn().mockResolvedValue(encoded.sets) },
      },
    });

    await expect(loadLists()).resolves.toEqual(lists);
  });

  it('keeps the local canonical snapshot while sharded Sync is incomplete', async () => {
    const localLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'keep-local.example' }],
    };
    const exclusions: ListsConfig['exclusions'] = {};
    for (const categoryId of CATEGORY_IDS) {
      exclusions[categoryId] = Array.from(
        { length: 60 },
        (_value: unknown, index: number): string => `${categoryId}-${index}.example`,
      );
    }
    const encoded = await encodeListsForSync({ ...DEFAULT_LISTS, exclusions });
    const incomplete: Record<string, unknown> = { ...encoded.sets };
    delete incomplete[LIST_SYNC_SHARD_KEYS[0] as string];
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({ [LOCAL_LISTS_SNAPSHOT]: localLists }),
        },
        sync: { get: vi.fn().mockResolvedValue(incomplete) },
      },
    });

    await expect(loadLists()).resolves.toEqual(localLists);
  });
});

describe('matcher cache storage', () => {
  const cache: StoredMatcherCache = {
    version: 2,
    sourceSignature: '{"lists":{},"categories":[]}',
    compiledSignature: '',
    modes: {
      blacklist: { mode: 'blacklist', hosts: [], regexes: [], excluded: [] },
      whitelist: { mode: 'whitelist', hosts: [], regexes: [], excluded: [] },
    },
  };

  it('loads the raw cache from local storage without permissive parsing', async () => {
    const malformed = { version: 1, modes: { blacklist: null } };
    const localGet = vi.fn().mockResolvedValue({ [LOCAL_CACHES]: malformed });
    vi.stubGlobal('chrome', {
      storage: {
        local: { get: localGet },
        sync: { get: vi.fn() },
      },
    });

    await expect(loadMatcherCache()).resolves.toBe(malformed);
    expect(localGet).toHaveBeenCalledWith(LOCAL_CACHES);
    expect(chrome.storage.sync.get).not.toHaveBeenCalled();
  });

  it('saves the typed cache only to local storage', async () => {
    const localSet = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('chrome', {
      storage: {
        local: { set: localSet },
        sync: { set: vi.fn() },
      },
    });

    await saveMatcherCache(cache);

    expect(localSet).toHaveBeenCalledWith({ [LOCAL_CACHES]: cache });
    expect(chrome.storage.sync.set).not.toHaveBeenCalled();
  });
});

describe('storage default merging', () => {
  it('preserves nested settings defaults when stored objects are partial', () => {
    const settings: Settings = mergeSettings({
      pause: { earnRatio: 0.25 },
      gate: { delayMs: 30_000 },
      sounds: { masterVolume: 0.2 },
    });

    expect(settings.pause).toEqual({ ...DEFAULT_SETTINGS.pause, earnRatio: 0.25 });
    expect(settings.gate).toEqual({ ...DEFAULT_SETTINGS.gate, delayMs: 30_000 });
    expect(settings.sounds).toEqual({ ...DEFAULT_SETTINGS.sounds, masterVolume: 0.2 });
    expect(settings.streakFreezeIntervalDays).toBe(7);
    expect(settings.sessionCompleteNotification).toBe(true);
  });

  it.each([
    ['zero', 0],
    ['maximum safe integer days', Number.MAX_SAFE_INTEGER],
    ['past the Date range', 100_000_001],
  ])('migrates a %s freeze cadence to the seven-day default', (_label: string, value: number) => {
    const settings: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: value,
    });

    expect(settings.streakFreezeIntervalDays).toBe(7);
  });

  it('preserves the exact upper freeze cadence boundary', () => {
    const settings: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      streakFreezeIntervalDays: 100_000_000,
    });

    expect(settings.streakFreezeIntervalDays).toBe(100_000_000);
  });

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
    ['maximum safe integer days', Number.MAX_SAFE_INTEGER],
    ['past the Date range', 100_000_001],
  ])('migrates %s retention to the default', (_label: string, value: number): void => {
    const settings: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      retentionDays: value,
    });

    expect(settings.retentionDays).toBe(DEFAULT_SETTINGS.retentionDays);
  });

  it('preserves the exact upper retention boundary', (): void => {
    const settings: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      retentionDays: 100_000_000,
    });

    expect(settings.retentionDays).toBe(100_000_000);
  });

  it.each([
    ['zero', [0, 25, 50]],
    ['sub-millisecond', [0.000_001, 25, 50]],
    ['unsafe', [15, Number.MAX_SAFE_INTEGER, 50]],
    ['past the relative-duration cap', [15, 72_000_000_001, 50]],
  ])('migrates %s presets to defaults', (_label: string, presetsMin: number[]) => {
    const settings: Settings = mergeSettings({ ...DEFAULT_SETTINGS, presetsMin });

    expect(settings.presetsMin).toEqual(DEFAULT_SETTINGS.presetsMin);
  });

  it('preserves fractional presets and the exact relative-duration cap', () => {
    const settings: Settings = mergeSettings({
      ...DEFAULT_SETTINGS,
      presetsMin: [0.1, 25.5, 72_000_000_000],
    });

    expect(settings.presetsMin).toEqual([0.1, 25.5, 72_000_000_000]);
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

  it('sanitizes malformed settings and list fields from sync storage', async () => {
    const validSchedule = {
      id: 'weekday-focus',
      days: [1, 2, 3, 4, 5],
      start: '09:00',
      end: '10:00',
      mode: 'blacklist',
      strictness: 'hard',
      cycling: null,
      intention: 'Work',
      enabled: true,
    };
    const stored: Record<string, unknown> = {
      [SYNC_SETTINGS]: {
        presetsMin: [5, 'bad', 30],
        defaultMode: 'invalid',
        defaultStrictness: 'hard',
        defaultCycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 0 },
        cyclingOnByDefault: 'yes',
        pause: {
          earnRatio: -1,
          capMs: 123,
          pauseMs: Number.POSITIVE_INFINITY,
          unlockMs: 456,
        },
        gate: { delayMs: -1, requireTypedPhrase: true },
        badgeCountdown: 'yes',
        sounds: {
          masterVolume: 2,
          sessionComplete: false,
          breakStart: 'yes',
          breakEnd: true,
          scheduleStart: false,
        },
        schedule: [validSchedule, { ...validSchedule, id: ' ', start: 'tomorrow' }],
        streakGoalMin: -1,
        streakFreezeIntervalDays: 0,
        sessionCompleteNotification: 'yes',
        retentionDays: 30,
        unknownField: 'discard me',
      },
      [SYNC_LISTS]: {
        custom: [
          { kind: 'host', pattern: 'blocked.example' },
          { kind: 'regex', pattern: '' },
          { kind: 'unknown', pattern: 'bad.example' },
          null,
        ],
        whitelist: 'not-an-array',
        categories: { social: true, video: 'yes', unknown: true },
        exclusions: {
          social: ['facebook.com', 42, ''],
          video: 'not-an-array',
          unknown: ['ignored.example'],
        },
        unknownField: 'discard me',
      },
    };
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: vi.fn(async (keys: string | string[]): Promise<Record<string, unknown>> => {
            const requested: string[] = Array.isArray(keys) ? keys : [keys];
            return Object.fromEntries(
              requested.map((key: string): [string, unknown] => [key, stored[key]]),
            );
          }),
        },
      },
    });

    const [settings, lists] = await Promise.all([loadSettings(), loadLists()]);

    expect(settings).toMatchObject({
      presetsMin: DEFAULT_SETTINGS.presetsMin,
      defaultMode: DEFAULT_SETTINGS.defaultMode,
      defaultStrictness: 'hard',
      defaultCycling: DEFAULT_SETTINGS.defaultCycling,
      cyclingOnByDefault: DEFAULT_SETTINGS.cyclingOnByDefault,
      pause: {
        earnRatio: DEFAULT_SETTINGS.pause.earnRatio,
        capMs: 123,
        pauseMs: DEFAULT_SETTINGS.pause.pauseMs,
        unlockMs: 456,
      },
      gate: { delayMs: DEFAULT_SETTINGS.gate.delayMs, requireTypedPhrase: true },
      badgeCountdown: DEFAULT_SETTINGS.badgeCountdown,
      sounds: {
        masterVolume: DEFAULT_SETTINGS.sounds.masterVolume,
        sessionComplete: false,
        breakStart: DEFAULT_SETTINGS.sounds.breakStart,
        breakEnd: true,
        scheduleStart: false,
      },
      schedule: [validSchedule],
      streakGoalMin: DEFAULT_SETTINGS.streakGoalMin,
      streakFreezeIntervalDays: 7,
      sessionCompleteNotification: true,
      retentionDays: 30,
    });
    expect(settings).not.toHaveProperty('unknownField');
    expect(lists).toEqual({
      custom: [
        { kind: 'host', pattern: 'blocked.example' },
        { kind: 'regex', pattern: '' },
      ],
      whitelist: [],
      categories: { ...DEFAULT_LISTS.categories, social: true },
      exclusions: { social: ['facebook.com'] },
    });
  });

  it.each([
    { balanceMs: -1 },
    { balanceMs: Number.POSITIVE_INFINITY },
    { balanceMs: 'many' },
    null,
  ])('defaults a malformed bank from sync storage', async (rawBank: unknown) => {
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: vi.fn().mockResolvedValue({ [SYNC_BANK]: rawBank }),
        },
      },
    });

    await expect(loadBank()).resolves.toEqual({ balanceMs: 0 });
  });

  it.each([
    { current: -1 },
    { current: 1, freezeTokens: 3 },
    { current: 1, freezeTokens: 1, activeDays: [0] },
    { current: 1, freezeTokens: 1, activeDays: [], activeMonth: 'not-a-month' },
  ])('rejects a malformed streak from sync storage', async (rawStreak: object) => {
    vi.stubGlobal('chrome', {
      storage: {
        sync: {
          get: vi.fn().mockResolvedValue({ [SYNC_STREAK]: rawStreak }),
        },
      },
    });

    await expect(loadStreak()).resolves.toBeNull();
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

  it.each([
    { attempts: [], focusMs: 1 },
    { attempts: {}, focusMs: 'one' },
    { attempts: {}, focusMs: 1, date: 'not-a-date' },
  ])('rejects a malformed stored daily aggregate without throwing', (todayAgg: object) => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();

    expect((): void => {
      const runtime = mergeRuntime({ date: '2026-08-29', todayAgg }, now);
      expect(runtime.todayAgg).toBeNull();
    }).not.toThrow();
  });

  it.each([
    {},
    {
      sessionId: 'bad-phase',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: 1,
      sessionEndsAt: 2,
      phase: 'wrong',
      phaseStartedAt: 1,
      phaseEndsAt: 2,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
    {
      sessionId: 'bad-config',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 0 },
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: 1,
      sessionEndsAt: 2,
      phase: 'focus',
      phaseStartedAt: 1,
      phaseEndsAt: 2,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
    {
      sessionId: 'bad-time',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: -1,
      sessionEndsAt: 2,
      phase: 'focus',
      phaseStartedAt: 1,
      phaseEndsAt: Number.NaN,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
    {
      sessionId: 'bad-pause',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: 1,
      sessionEndsAt: 10,
      phase: 'paused',
      phaseStartedAt: 2,
      phaseEndsAt: 5,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 1,
    },
    {
      sessionId: 'bad-order',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: 2,
      sessionEndsAt: 10,
      phase: 'focus',
      phaseStartedAt: 5,
      phaseEndsAt: 1,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
    {
      sessionId: '   ',
      config: {
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual',
        scheduleEntryId: null,
      },
      startedAt: 1,
      sessionEndsAt: 2,
      phase: 'focus',
      phaseStartedAt: 1,
      phaseEndsAt: 2,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    },
  ])('rejects a malformed persisted session safely', (session: object) => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const runtime = mergeRuntime({ session }, now);

    expect(runtime.session).toBeNull();
  });

  it('sanitizes every malformed runtime field independently', () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const runtime = mergeRuntime(
      {
        gate: { kind: 'pause', openedAt: -1 },
        unlocks: [{ host: 42, until: Number.POSITIVE_INFINITY }],
        accruedFocusMs: -1,
        attemptDebounce: { bad: 'yesterday' },
        scheduleActiveEntryId: 42,
        lastPruneDate: 'not-a-date',
        commitCheckpoint: { bank: { balanceMs: -1 }, events: [{}], syncBank: 'yes' },
      },
      now,
    );

    expect(runtime).toMatchObject({
      session: null,
      gate: null,
      unlocks: [],
      accruedFocusMs: 0,
      attemptDebounce: {},
      scheduleActiveEntryId: null,
      lastPruneDate: null,
      commitCheckpoint: null,
    });
  });

  it('preserves a valid legacy session without copying unknown runtime fields', () => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const session = {
      config: {
        mode: 'blacklist' as const,
        strictness: 'friction' as const,
        durationMin: 25,
        cycling: null,
        intention: '',
        source: 'manual' as const,
        scheduleEntryId: null,
      },
      startedAt: now,
      sessionEndsAt: now + 25 * 60_000,
      phase: 'focus' as const,
      phaseStartedAt: now,
      phaseEndsAt: now + 25 * 60_000,
      cycleIndex: 0,
      pausedFrom: null,
      focusedMs: 0,
    };

    const runtime = mergeRuntime({ session, unknownField: 'discard me' }, now);

    expect(runtime.session).toEqual(session);
    expect(runtime).not.toHaveProperty('unknownField');
  });

  it.each([
    { t: 'unknown', at: 1 },
    { t: 'budgetEarned', at: 1, ms: 500, sessionId: '   ' },
  ])('rejects a checkpoint containing a malformed event', (event: object) => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const runtime = mergeRuntime(
      {
        commitCheckpoint: {
          bank: { balanceMs: 500 },
          events: [event],
          syncBank: true,
        },
      },
      now,
    );

    expect(runtime.commitCheckpoint).toBeNull();
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

describe('event storage replay', () => {
  it('drops malformed stored events while preserving valid records', async () => {
    const valid: EventRecord = {
      t: 'budgetEarned',
      at: 1,
      ms: 500,
      sessionId: 'session-one',
    };
    const identityAssigned: EventRecord = {
      t: 'sessionIdentityAssigned',
      at: 2,
      startedAt: 0,
      sessionId: 'session-one',
    };
    const state: Record<string, unknown> = {
      [LOCAL_EVENTS]: [
        valid,
        identityAssigned,
        null,
        { t: 'budgetEarned', at: Number.NaN, ms: 500 },
        { t: 'sessionIdentityAssigned', at: 2, startedAt: 0 },
        { t: 'sessionIdentityAssigned', at: 2, startedAt: -1, sessionId: 'session-one' },
        { t: 'sessionIdentityAssigned', at: 2, startedAt: 0, sessionId: ' ' },
        { t: 'unknown', at: 2 },
      ],
    };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => state),
          set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(state, items);
          }),
        },
      },
    });

    await expect(readEvents()).resolves.toEqual([valid, identityAssigned]);
    await appendEvents([{ t: 'pauseTaken', at: 2, ms: 100, sessionId: 'session-one' }]);
    expect(state[LOCAL_EVENTS]).toEqual([
      valid,
      identityAssigned,
      { t: 'pauseTaken', at: 2, ms: 100, sessionId: 'session-one' },
    ]);
  });

  it('repairs a non-array event log before appending', async () => {
    const event: EventRecord = { t: 'budgetEarned', at: 1, ms: 500 };
    const state: Record<string, unknown> = { [LOCAL_EVENTS]: { malformed: true } };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => state),
          set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(state, items);
          }),
        },
      },
    });

    await expect(appendEvents([event])).resolves.toBeUndefined();
    expect(state[LOCAL_EVENTS]).toEqual([event]);
  });

  it('does not append an identical checkpoint event twice', async () => {
    const event = {
      t: 'budgetEarned' as const,
      at: 1,
      ms: 500,
      sessionId: 'session-one',
    };
    const state: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => state),
          set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
            Object.assign(state, items);
          }),
        },
      },
    });

    await appendEvents([event]);
    await appendEvents([event]);

    expect(state[LOCAL_EVENTS]).toEqual([event]);
  });

  it('continues appending after an event-log write rejects', async () => {
    const state: Record<string, unknown> = { [LOCAL_EVENTS]: [] };
    const first: EventRecord = { t: 'budgetEarned', at: 1, ms: 500 };
    const second: EventRecord = { t: 'pauseTaken', at: 2, ms: 100 };
    const setLocal = vi
      .fn<(items: Record<string, unknown>) => Promise<void>>()
      .mockRejectedValueOnce(new Error('event storage unavailable'))
      .mockImplementation(async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(state, items);
      });
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn(async (): Promise<Record<string, unknown>> => structuredClone(state)),
          set: setLocal,
        },
      },
    });

    await expect(appendEvents([first])).rejects.toThrow('event storage unavailable');
    await expect(appendEvents([second])).resolves.toBeUndefined();

    expect(state[LOCAL_EVENTS]).toEqual([second]);
  });
});
