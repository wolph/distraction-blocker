import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseRequest } from '../../../src/background/request-validation';
import { DEFAULT_LISTS, DEFAULT_SETTINGS, emptySnapshot } from '../../../src/shared/constants';
import type { StatsBundle } from '../../../src/shared/messages';
import {
  ackError,
  isCycleConfig,
  isDeviceId,
  isEventRecord,
  isListsConfig,
  isPauseEconomy,
  isSessionSnapshot,
  isSettings,
  isStatsBundle,
  parseEventExportResponse,
} from '../../../src/shared/runtime-validation';
import type {
  DailyAgg,
  EventRecord,
  ListsConfig,
  MonthlyAgg,
  Rule,
  SessionConfig,
  SessionSnapshot,
  SiteUnlock,
} from '../../../src/shared/types';

afterEach((): void => {
  vi.restoreAllMocks();
});

const NOW: number = 1_700_000_000_000;
const CONFIG: SessionConfig = {
  mode: 'blacklist',
  strictness: 'friction',
  durationMin: 25,
  cycling: DEFAULT_SETTINGS.defaultCycling,
  intention: 'write report',
  source: 'manual',
  scheduleEntryId: null,
};

function activeSnapshot(config: unknown = CONFIG): unknown {
  return {
    ...emptySnapshot(NOW),
    phase: 'focus',
    config,
    startedAt: NOW - 10_000,
    phaseStartedAt: NOW - 10_000,
    phaseEndsAt: NOW + 10_000,
    sessionEndsAt: NOW + 20_000,
  };
}

function statsBundle(update: Partial<StatsBundle> = {}): StatsBundle {
  return {
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
    ...update,
  };
}

function sparseArray<T>(length: number, values: Readonly<Record<number, T>> = {}): T[] {
  const result: T[] = new Array<T>(length);
  for (const [index, value] of Object.entries(values)) result[Number(index)] = value;
  return result;
}

describe('runtime validation dense array boundaries', (): void => {
  it.each([
    [
      'custom rules',
      (): boolean => isListsConfig({ ...DEFAULT_LISTS, custom: sparseArray<Rule>(1) }),
    ],
    [
      'whitelist rules',
      (): boolean => isListsConfig({ ...DEFAULT_LISTS, whitelist: sparseArray<Rule>(1) }),
    ],
    [
      'exclusion hosts',
      (): boolean =>
        isListsConfig({
          ...DEFAULT_LISTS,
          exclusions: { social: sparseArray<string>(1) },
        }),
    ],
    [
      'active unlocks',
      (): boolean =>
        isSessionSnapshot({
          ...(activeSnapshot() as SessionSnapshot),
          activeUnlocks: sparseArray<SiteUnlock>(1),
        }),
    ],
    [
      'streak active days',
      (): boolean =>
        isStatsBundle(
          statsBundle({
            streak: {
              ...statsBundle().streak,
              activeDays: sparseArray<number>(1),
            },
          }),
        ),
    ],
    [
      'daily aggregates',
      (): boolean => isStatsBundle(statsBundle({ days: sparseArray<DailyAgg>(1) })),
    ],
    [
      'monthly aggregates',
      (): boolean => isStatsBundle(statsBundle({ months: sparseArray<MonthlyAgg>(1) })),
    ],
    [
      'recent sessions',
      (): boolean => isStatsBundle(statsBundle({ recentSessions: sparseArray<EventRecord>(1) })),
    ],
  ])('rejects sparse %s without throwing', (_label: string, validate: () => boolean): void => {
    expect(validate).not.toThrow();
    expect(validate()).toBe(false);
  });

  it('rejects a sparse event array returned by the JSON boundary', (): void => {
    vi.spyOn(JSON, 'parse').mockReturnValue(sparseArray<EventRecord>(1));

    expect(parseEventExportResponse({ json: '[]' })).toBeNull();
  });
});

describe('runtime and worker request validation parity', (): void => {
  it('defines Auto as the default theme', (): void => {
    expect(DEFAULT_SETTINGS).toHaveProperty('theme', 'auto');
  });

  it.each([
    ['valid settings', DEFAULT_SETTINGS, true],
    ['Auto theme', { ...DEFAULT_SETTINGS, theme: 'auto' }, true],
    ['Light theme', { ...DEFAULT_SETTINGS, theme: 'light' }, true],
    ['Dark theme', { ...DEFAULT_SETTINGS, theme: 'dark' }, true],
    ['unknown theme', { ...DEFAULT_SETTINGS, theme: 'sepia' }, false],
    ['top-level extra settings key', { ...DEFAULT_SETTINGS, extra: true }, false],
    [
      'nested extra pause key',
      { ...DEFAULT_SETTINGS, pause: { ...DEFAULT_SETTINGS.pause, extra: true } },
      false,
    ],
    [
      'sparse preset values',
      { ...DEFAULT_SETTINGS, presetsMin: sparseArray(3, { 0: 15, 2: 50 }) },
      false,
    ],
  ])(
    'matches worker settings validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'updateSettings', settings: value as typeof DEFAULT_SETTINGS }) !==
        null;
      expect(workerAccepted).toBe(accepted);
      expect(isSettings(value)).toBe(workerAccepted);
    },
  );

  it.each(['auto', 'light', 'dark'])(
    'accepts the %s theme in session snapshots',
    (theme: string): void => {
      expect(isSessionSnapshot({ ...(activeSnapshot() as SessionSnapshot), theme })).toBe(true);
    },
  );

  it('rejects an unknown session snapshot theme', (): void => {
    expect(isSessionSnapshot({ ...(activeSnapshot() as SessionSnapshot), theme: 'sepia' })).toBe(
      false,
    );
  });

  it.each([
    ['valid lists', DEFAULT_LISTS, true],
    ['top-level extra lists key', { ...DEFAULT_LISTS, extra: true }, false],
    [
      'extra custom rule key',
      { ...DEFAULT_LISTS, custom: [{ kind: 'host', pattern: 'example.com', extra: true }] },
      false,
    ],
    [
      'extra category key',
      { ...DEFAULT_LISTS, categories: { ...DEFAULT_LISTS.categories, extra: false } },
      false,
    ],
    [
      'unknown exclusion category',
      { ...DEFAULT_LISTS, exclusions: { unknown: ['example.com'] } },
      false,
    ],
    [
      'untrimmed exclusion host',
      { ...DEFAULT_LISTS, exclusions: { social: [' example.com'] } },
      false,
    ],
  ])(
    'matches worker list validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'updateLists', lists: value as ListsConfig }) !== null;
      expect(workerAccepted).toBe(accepted);
      expect(isListsConfig(value)).toBe(workerAccepted);
    },
  );

  it.each([
    ['valid session config', CONFIG, true],
    ['extra session config key', { ...CONFIG, extra: true }, false],
    [
      'extra cycle config key',
      { ...CONFIG, cycling: { ...DEFAULT_SETTINGS.defaultCycling, extra: true } },
      false,
    ],
    ['manual config with schedule id', { ...CONFIG, scheduleEntryId: 'unexpected' }, false],
  ])(
    'matches worker session validation for %s',
    (_label: string, value: unknown, accepted: boolean): void => {
      const workerAccepted: boolean =
        parseRequest({ type: 'startSession', config: value as SessionConfig }) !== null;
      expect(workerAccepted).toBe(accepted);
      expect(isSessionSnapshot(activeSnapshot(value))).toBe(workerAccepted);
    },
  );
});

describe('exported runtime validators are total for hostile unknowns', (): void => {
  it('returns rejection values for a revoked proxy', (): void => {
    const revocable: { proxy: object; revoke: () => void } = Proxy.revocable<object>({}, {});
    revocable.revoke();
    const hostile: unknown = revocable.proxy;
    const booleanValidators: ReadonlyArray<(value: unknown) => boolean> = [
      isCycleConfig,
      isPauseEconomy,
      isSettings,
      isListsConfig,
      isSessionSnapshot,
      isEventRecord,
      isStatsBundle,
      isDeviceId,
    ];

    for (const validate of booleanValidators) {
      expect((): boolean => validate(hostile)).not.toThrow();
      expect(validate(hostile)).toBe(false);
    }
    expect((): string | null => ackError(hostile, 'malformed')).not.toThrow();
    expect(ackError(hostile, 'malformed')).toBe('malformed');
    expect((): EventRecord[] | null => parseEventExportResponse(hostile)).not.toThrow();
    expect(parseEventExportResponse(hostile)).toBeNull();
  });

  it('returns rejection values when property access and reflection throw', (): void => {
    const hostile: unknown = new Proxy<Record<string, unknown>>(
      {},
      {
        get: (): never => {
          throw new Error('get trap');
        },
        ownKeys: (): never => {
          throw new Error('ownKeys trap');
        },
      },
    );

    expect((): boolean => isSettings(hostile)).not.toThrow();
    expect(isSettings(hostile)).toBe(false);
    expect((): boolean => isListsConfig(hostile)).not.toThrow();
    expect(isListsConfig(hostile)).toBe(false);
    expect((): boolean => isSessionSnapshot(hostile)).not.toThrow();
    expect(isSessionSnapshot(hostile)).toBe(false);
    expect((): boolean => isStatsBundle(hostile)).not.toThrow();
    expect(isStatsBundle(hostile)).toBe(false);
    expect((): string | null => ackError(hostile, 'malformed')).not.toThrow();
    expect(ackError(hostile, 'malformed')).toBe('malformed');
    expect((): EventRecord[] | null => parseEventExportResponse(hostile)).not.toThrow();
    expect(parseEventExportResponse(hostile)).toBeNull();
  });
});
