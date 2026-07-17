import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { encodeListsForSync, LIST_SYNC_SHARD_KEYS } from '../../../src/background/list-sync-codec';
import { projectRuntimeDomainV2 } from '../../../src/background/runtime-checkpoint-v2';
import { emptyRuntimeV2 } from '../../../src/background/runtime-store-v2';
import type { RuntimeStateV2 } from '../../../src/background/runtime-v2-types';
import type { LegacyRuntimeStateV1, ParsedRuntimeState } from '../../../src/background/stores';
import {
  loadBank,
  loadLists,
  loadMatcherCache,
  loadRuntime,
  loadSettings,
  loadStreak,
  mergeLists,
  mergeRuntime,
  mergeSettings,
  migrateRuntimeRules,
  parseStoredSettings,
  sanitizeRuntimeForLocalHistory,
  saveMatcherCache,
} from '../../../src/background/stores';
import type { StoredMatcherCache } from '../../../src/core/matcher';
import { emptyDaily } from '../../../src/core/stats';
import {
  CATEGORY_IDS,
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  rulesFromLists,
} from '../../../src/shared/constants';
import {
  LOCAL_CACHES,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_RUNTIME,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../../../src/shared/storage-keys';
import type { DailyAgg, ListsConfig, Settings, StreakState } from '../../../src/shared/types';

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
  it.each([false, true])(
    'accepts the canonical gate.allowForceEnd=%s as is, with no migration',
    (allowForceEnd: boolean): void => {
      const settings: Settings = {
        ...structuredClone(DEFAULT_SETTINGS),
        retentionDays: 30,
        gate: { delayMs: 30_000, requireTypedPhrase: true, allowForceEnd },
      };
      const stored: Settings = structuredClone(settings);
      Object.freeze(stored);
      Object.freeze(stored.gate);

      expect(parseStoredSettings(stored)).toEqual({
        valid: true,
        changed: true,
        legacy: false,
        settings,
      });
      expect(parseStoredSettings(stored, settings)).toMatchObject({ valid: true, changed: false });
    },
  );

  /** The root-level v1 record: the boolean beside `gate`, and a gate that never carried it. */
  function v1Settings(
    overrides: Partial<Settings>,
    allowForceEnd: boolean,
  ): Record<string, unknown> {
    const { allowForceEnd: _nested, ...gate } = { ...DEFAULT_SETTINGS.gate, ...overrides.gate };
    return { ...structuredClone(DEFAULT_SETTINGS), ...overrides, gate, allowForceEnd };
  }

  it('accepts a gate that lacks allowForceEnd as the pre-force-end v1 shape and defaults it to false', (): void => {
    const stored: Record<string, unknown> = {
      ...structuredClone(DEFAULT_SETTINGS),
      gate: { delayMs: 10_000, requireTypedPhrase: false },
    };
    const bypassOn: Settings = {
      ...DEFAULT_SETTINGS,
      gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true },
    };

    expect(parseStoredSettings(stored, DEFAULT_SETTINGS)).toEqual({
      valid: true,
      changed: false,
      legacy: true,
      settings: DEFAULT_SETTINGS,
    });
    expect(parseStoredSettings(stored, bypassOn)).toEqual({
      valid: true,
      changed: true,
      legacy: true,
      settings: DEFAULT_SETTINGS,
    });
    expect(stored.gate).not.toHaveProperty('allowForceEnd');
  });

  it('keeps customised settings around a pre-force-end gate', (): void => {
    const stored: Record<string, unknown> = {
      ...structuredClone(DEFAULT_SETTINGS),
      theme: 'dark',
      retentionDays: 30,
      gate: { delayMs: 20_000, requireTypedPhrase: true },
    };

    expect(parseStoredSettings(stored, DEFAULT_SETTINGS)).toEqual({
      valid: true,
      changed: true,
      legacy: true,
      settings: {
        ...DEFAULT_SETTINGS,
        theme: 'dark',
        retentionDays: 30,
        gate: { delayMs: 20_000, requireTypedPhrase: true, allowForceEnd: false },
      },
    });
  });

  it.each([
    { gate: { delayMs: 10_000 } },
    { gate: { delayMs: 10_000, requireTypedPhrase: false, unexpected: true } },
    { gate: { delayMs: -1, requireTypedPhrase: false } },
    { gate: { delayMs: 10_000, requireTypedPhrase: false }, unexpected: true },
  ])(
    'rejects an invalid pre-force-end gate record %#',
    (overrides: Record<string, unknown>): void => {
      expect(parseStoredSettings({ ...structuredClone(DEFAULT_SETTINGS), ...overrides })).toEqual({
        valid: false,
      });
    },
  );

  it.each([
    { gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: 'false' } },
    { gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: false, unexpected: true } },
    { gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true }, unexpected: true },
    { gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true }, allowForceEnd: 'false' },
    { gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true, delayMs: -1 } },
  ])('rejects invalid installed writer settings %#', (overrides: Record<string, unknown>): void => {
    expect(parseStoredSettings({ ...structuredClone(DEFAULT_SETTINGS), ...overrides })).toEqual({
      valid: false,
    });
  });

  it('accepts the exact legacy settings shape and distinguishes unchanged normalization', (): void => {
    const legacy: Record<string, unknown> = {
      ...structuredClone(DEFAULT_SETTINGS),
      allowForceEnd: false,
    };

    expect(parseStoredSettings(legacy, DEFAULT_SETTINGS)).toEqual({
      valid: true,
      changed: false,
      legacy: true,
      settings: DEFAULT_SETTINGS,
    });
  });

  it('moves the root-level v1 boolean into the gate and keeps customized settings', (): void => {
    const legacy: Record<string, unknown> = v1Settings({ retentionDays: 30 }, true);

    expect(legacy.gate).not.toHaveProperty('allowForceEnd');
    expect(parseStoredSettings(legacy, DEFAULT_SETTINGS)).toEqual({
      valid: true,
      changed: true,
      legacy: true,
      settings: {
        ...DEFAULT_SETTINGS,
        retentionDays: 30,
        gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: true },
      },
    });
  });

  it('lets a nested field win over a root-level one when a record carries both', (): void => {
    expect(
      parseStoredSettings({
        ...structuredClone(DEFAULT_SETTINGS),
        allowForceEnd: true,
        gate: { ...DEFAULT_SETTINGS.gate, allowForceEnd: false },
      }),
    ).toEqual({ valid: true, changed: false, legacy: true, settings: DEFAULT_SETTINGS });
  });

  it('compares canonical and legacy settings by value instead of property order', (): void => {
    const reordered: Settings = Object.fromEntries(
      Object.entries(DEFAULT_SETTINGS).reverse(),
    ) as Settings;
    const reorderedLegacy: Record<string, unknown> = {
      ...reordered,
      allowForceEnd: false,
    };

    expect(parseStoredSettings(reordered, DEFAULT_SETTINGS)).toMatchObject({
      valid: true,
      changed: false,
      legacy: false,
    });
    expect(parseStoredSettings(reorderedLegacy, DEFAULT_SETTINGS)).toMatchObject({
      valid: true,
      changed: false,
      legacy: true,
    });
  });

  it.each([
    { ...structuredClone(DEFAULT_SETTINGS), allowForceEnd: 'yes' },
    { ...structuredClone(DEFAULT_SETTINGS), allowForceEnd: false, unexpected: true },
  ])('rejects malformed or wider legacy settings %#', (legacy: Record<string, unknown>): void => {
    expect(parseStoredSettings(legacy, DEFAULT_SETTINGS)).toEqual({ valid: false });
  });

  it.each([
    ['auto', 'auto'],
    ['light', 'light'],
    ['dark', 'dark'],
    ['unknown', 'sepia'],
  ] as const)('merges the %s stored theme safely', (label: string, storedTheme: string): void => {
    const settings: Settings = mergeSettings({ ...DEFAULT_SETTINGS, theme: storedTheme });

    expect(settings).toHaveProperty(
      'theme',
      label === 'unknown' ? DEFAULT_SETTINGS.theme : storedTheme,
    );
  });

  it('preserves nested settings defaults when stored objects are partial', () => {
    const settings: Settings = mergeSettings({
      pause: { earnRatio: 0.25 },
      gate: { delayMs: 30_000 },
      sounds: { masterVolume: 0.2 },
    });

    expect(settings.pause).toEqual({ ...DEFAULT_SETTINGS.pause, earnRatio: 0.25 });
    expect(settings.theme).toBe('auto');
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

  it('preserves Flexible as the stored default strictness', (): void => {
    expect(mergeSettings({ defaultStrictness: 'flexible' }).defaultStrictness).toBe('flexible');
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
      gate: {
        delayMs: DEFAULT_SETTINGS.gate.delayMs,
        requireTypedPhrase: true,
        allowForceEnd: DEFAULT_SETTINGS.gate.allowForceEnd,
      },
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
      custom: [{ kind: 'host', pattern: 'blocked.example' }],
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

const EPOCH_ID: string = '30000000-0000-4000-8000-000000000001';

describe('runtime storage migration', () => {
  it('sanitizes restart runtime history without changing active runtime ownership', (): void => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const empty: RuntimeStateV2 = emptyRuntimeV2(now, EPOCH_ID);
    const runtime: RuntimeStateV2 = {
      ...empty,
      gate: {
        kind: 'pause',
        host: null,
        openedAt: now,
        readyAt: now + 1_000,
        requiredPhrase: null,
        forceEndAvailable: false,
      },
      unlocks: [{ host: 'allowed.example', until: now + 60_000 }],
      todayAgg: { ...emptyDaily('2026-08-29'), focusMs: 60_000 },
      commitCheckpoint: {
        version: 2,
        checkpointId: 'restart-history',
        projection: projectRuntimeDomainV2(empty),
        bank: { balanceMs: 42_000 },
        events: [{ t: 'budgetEarned', at: now, ms: 1_000 }],
        syncBank: true,
        aggregateSets: {
          'agg:device:2026-08-29': { ...emptyDaily('2026-08-29'), focusMs: 60_000 },
        },
        aggregateRemoves: [],
      },
    };

    const local = sanitizeRuntimeForLocalHistory(runtime, true);
    const sync = sanitizeRuntimeForLocalHistory(runtime, false);

    expect(local).toMatchObject({
      gate: runtime.gate,
      unlocks: runtime.unlocks,
      todayAgg: null,
      commitCheckpoint: null,
    });
    expect(sync).toMatchObject({
      gate: runtime.gate,
      unlocks: runtime.unlocks,
      todayAgg: runtime.todayAgg,
      commitCheckpoint: null,
    });
    expect(runtime.todayAgg).not.toBeNull();
    expect(runtime.commitCheckpoint).not.toBeNull();
  });

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
        removedTabTombstones: { '-1': true, 7: false, invalid: true },
        deferredBlockClaims: {
          missingSession: {
            attemptAt: now,
            kind: 'navigation',
            stage: 'attempt',
            tabId: 7,
            url: 'https://blocked.example',
          },
          stoppedWithoutDocument: {
            attemptAt: now,
            kind: 'navigation',
            sessionId: 'session-one',
            stage: 'stopped',
            tabId: 7,
            url: 'https://blocked.example',
          },
          blankSession: {
            attemptAt: now,
            kind: 'existing',
            sessionId: '   ',
            stage: 'attempt',
            tabId: 7,
            url: 'https://blocked.example',
          },
        },
        scheduleActiveEntryId: 42,
        scheduleUnavailableNoticeToken: 42,
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
      deferredBlockClaims: {},
      removedTabTombstones: {},
      scheduleActiveEntryId: null,
      scheduleUnavailableNoticeToken: null,
      lastPruneDate: null,
      commitCheckpoint: null,
    });
  });

  it('applies valid removed-tab tombstones before exposing persisted runtime', (): void => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const runtime = mergeRuntime(
      {
        attemptDebounce: {
          '7:https://blocked.example': now,
          '8:https://allowed.example': now,
        },
        deferredBlockClaims: {
          removed: {
            attemptAt: now,
            kind: 'existing',
            sessionId: 'session-one',
            stage: 'attempt',
            tabId: 7,
            url: 'https://blocked.example',
          },
          retained: {
            attemptAt: now,
            kind: 'existing',
            sessionId: 'session-one',
            stage: 'attempt',
            tabId: 8,
            url: 'https://allowed.example',
          },
        },
        removedTabTombstones: { 7: true },
        tabStates: {
          7: { muteUrl: 'https://blocked.example', priorMuted: false, stoppedDocumentId: null },
          8: { muteUrl: 'https://allowed.example', priorMuted: false, stoppedDocumentId: null },
        },
      },
      now,
    );

    expect(runtime.removedTabTombstones).toEqual({ 7: true });
    expect(runtime.tabStates).toEqual({
      8: { muteUrl: 'https://allowed.example', priorMuted: false, stoppedDocumentId: null },
    });
    expect(runtime.attemptDebounce).toEqual({ '8:https://allowed.example': now });
    expect(runtime.deferredBlockClaims).toEqual({
      retained: {
        attemptAt: now,
        kind: 'existing',
        sessionId: 'session-one',
        stage: 'attempt',
        tabId: 8,
        url: 'https://allowed.example',
      },
    });
  });

  it('preserves valid deferred navigation claims for restart replay', (): void => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const claim = {
      attemptAt: now - 31_000,
      documentId: 'document-one',
      kind: 'navigation' as const,
      sessionId: 'session-one',
      stage: 'attempt' as const,
      tabId: 7,
      url: 'https://blocked.example/feed',
    };

    const runtime = mergeRuntime({ deferredBlockClaims: { claim } }, now);

    expect(runtime.deferredBlockClaims).toEqual({ claim });
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

  it('migrates a legacy persisted session to the currently loaded lists', (): void => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const currentLists: ListsConfig = {
      ...DEFAULT_LISTS,
      custom: [{ kind: 'host', pattern: 'current.example' }],
    };
    const runtime = mergeRuntime(
      {
        session: {
          config: {
            mode: 'blacklist',
            strictness: 'friction',
            durationMin: 25,
            cycling: null,
            intention: '',
            source: 'manual',
            scheduleEntryId: null,
          },
          startedAt: now,
          sessionEndsAt: now + 25 * 60_000,
          phase: 'focus',
          phaseStartedAt: now,
          phaseEndsAt: now + 25 * 60_000,
          cycleIndex: 0,
          pausedFrom: null,
          focusedMs: 0,
        },
      },
      now,
    );

    expectTypeOf(runtime).toEqualTypeOf<ParsedRuntimeState>();
    const normalized: LegacyRuntimeStateV1 = migrateRuntimeRules(runtime, currentLists);
    expectTypeOf(normalized).toEqualTypeOf<LegacyRuntimeStateV1>();
    expect(normalized.session?.config.rules).toEqual(rulesFromLists(currentLists));
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

  it('caps recovered checkpoint daily attempts at the storage boundary', (): void => {
    const now: number = new Date(2026, 7, 29, 12, 0).getTime();
    const date: string = '2026-08-28';
    const runtime = mergeRuntime(
      {
        commitCheckpoint: {
          bank: { balanceMs: 0 },
          events: [],
          syncBank: false,
          aggregateSets: {
            [`agg:device-a:${date}`]: {
              date,
              focusMs: 0,
              sessionsStarted: 0,
              sessionsCompleted: 0,
              attempts: Object.fromEntries(
                Array.from({ length: 30 }, (_value: unknown, index: number): [string, number] => [
                  `site-${String(index).padStart(2, '0')}.example`,
                  30 - index,
                ]),
              ),
              attemptsOther: 0,
              pausesTaken: 0,
              pauseMsSpent: 0,
              pauseMsEarned: 0,
              unlocksTaken: 0,
              unlockMsSpent: 0,
              resisted: 0,
            },
          },
        },
      },
      now,
    );

    const aggregate: DailyAgg | undefined =
      runtime.commitCheckpoint?.aggregateSets?.[`agg:device-a:${date}`];
    expect(Object.keys(aggregate?.attempts ?? {})).toHaveLength(20);
    expect(aggregate?.attemptsOther).toBe(55);
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
