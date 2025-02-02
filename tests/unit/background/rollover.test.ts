import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clockRebaseArchiveKey,
  planBackwardDateRebase,
  planRollover,
  type RolloverPlan,
} from '../../../src/background/rollover';
import { applyPrunePlan, buildStats, pruneAndRollup } from '../../../src/background/stats-service';
import { SYNC_QUOTA_BYTES_TOTAL, syncItemBytes } from '../../../src/background/sync-quota';
import type { StatsBundle } from '../../../src/shared/messages';
import { SYNC_STREAK, syncAggKey } from '../../../src/shared/storage-keys';
import { localDateStr } from '../../../src/shared/time';
import type { DailyAgg, EventRecord, MonthlyAgg, StreakState } from '../../../src/shared/types';

const DAY_MS: number = 86_400_000;
const NOW: number = new Date(2026, 7, 29, 12, 0, 0).getTime();
const TODAY: string = localDateStr(NOW);
const YESTERDAY: string = localDateStr(NOW - DAY_MS);

function daily(date: string, over: Partial<DailyAgg>): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
    ...over,
  };
}

function monthly(month: string, over: Partial<MonthlyAgg>): MonthlyAgg {
  return {
    month,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
    ...over,
  };
}

const zeroStreak: StreakState = {
  current: 0,
  freezeTokens: 0,
  lastCountedDate: null,
  lastFreezeGrantDate: null,
  activeDays: [],
  activeMonth: TODAY.slice(0, 7),
};

describe('planRollover', () => {
  it('caps attempts, closes the streak day, mints an empty agg for the new date', () => {
    const attempts: Record<string, number> = {};
    for (let i = 0; i < 22; i++) attempts[`site${i}.com`] = i + 1;
    const agg: DailyAgg = daily(YESTERDAY, { focusMs: 30 * 60_000, attempts });
    const plan: RolloverPlan = planRollover(YESTERDAY, NOW, agg, zeroStreak, 25);
    expect(Object.keys(plan.finished.attempts)).toHaveLength(20);
    expect(plan.finished.attemptsOther).toBe(1 + 2);
    expect(plan.streak.current).toBe(1);
    expect(plan.streak.lastCountedDate).toBe(YESTERDAY);
    expect(plan.newAgg).toEqual(daily(TODAY, {}));
  });

  it('treats a day with no aggregation as zero focus, resetting the streak', () => {
    const started: StreakState = { ...zeroStreak, current: 4 };
    const plan: RolloverPlan = planRollover(YESTERDAY, NOW, null, started, 25);
    expect(plan.finished).toEqual(daily(YESTERDAY, {}));
    expect(plan.streak.current).toBe(0);
  });

  it('opens the new display month after closing the previous month correctly', () => {
    const now: number = new Date(2026, 9, 1, 0, 1).getTime();
    const streak: StreakState = {
      ...zeroStreak,
      current: 2,
      activeMonth: '2026-09',
      activeDays: [2, 30],
      freezeTokens: 1,
    };

    const plan: RolloverPlan = planRollover(
      '2026-09-30',
      now,
      daily('2026-09-30', { focusMs: 30 * 60_000 }),
      streak,
      25,
    );

    expect(plan.streak).toMatchObject({
      current: 3,
      activeMonth: '2026-10',
      activeDays: [],
      freezeTokens: 1,
      lastCountedDate: '2026-09-30',
    });
  });
});

describe('planBackwardDateRebase', () => {
  it('gives sequential and coalesced clock rebases distinct archive keys', () => {
    const at: number = new Date(2026, 9, 1, 12, 0).getTime();

    const first: string = clockRebaseArchiveKey('devA', '2026-10-02', at);
    const coalesced: string = clockRebaseArchiveKey('devA', '2026-10-03', at);
    const sequential: string = clockRebaseArchiveKey('devA', '2026-10-02', at + 1);
    const sameMillisecondA: string = clockRebaseArchiveKey('devA', '2026-10-02', at, 'a');
    const sameMillisecondB: string = clockRebaseArchiveKey('devA', '2026-10-02', at, 'b');

    expect(new Set([first, coalesced, sequential, sameMillisecondA, sameMillisecondB]).size).toBe(
      5,
    );
  });

  it('keeps clock oscillation archives separate until pruning', () => {
    expect(clockRebaseArchiveKey('devA', '2026-10-02', 1)).not.toBe(
      clockRebaseArchiveKey('devA', '2027-04-18', 2),
    );
  });

  it('quarantines the future-dated aggregate and starts the current day unset', () => {
    const current: DailyAgg = daily('2026-10-02', {
      focusMs: 60_000,
      attempts: { 'x.com': 2 },
    });

    const plan = planBackwardDateRebase('2026-10-01', current);

    expect(plan).toEqual({ archive: current, newAgg: null });
  });

  it('keeps rebased stats on the current day with no future daily item', () => {
    const futureDate: string = '2026-10-02';
    const archive: DailyAgg = daily(futureDate, { focusMs: 60_000 });
    const now: number = new Date(2026, 9, 1, 12, 0).getTime();
    const archiveKey: string = clockRebaseArchiveKey('devA', futureDate, now);

    const bundle: StatsBundle = buildStats(
      'devA',
      {
        [archiveKey]: archive,
        [syncAggKey('devA', futureDate)]: archive,
      },
      [],
      14,
      now,
    );

    expect(bundle.days).toEqual([]);
  });

  it('keeps rebased data separate when the former future day arrives', () => {
    const futureDate: string = '2026-10-02';
    const archived: DailyAgg = daily(futureDate, { focusMs: 60_000 });
    const actualFuture: DailyAgg = daily(futureDate, { focusMs: 120_000 });
    const now: number = new Date(2026, 9, 2, 12, 0).getTime();
    const archiveKey: string = clockRebaseArchiveKey('devA', futureDate, now - DAY_MS);

    const bundle: StatsBundle = buildStats(
      'devA',
      {
        [archiveKey]: archived,
        [syncAggKey('devA', futureDate)]: actualFuture,
      },
      [],
      14,
      now,
    );

    expect(bundle.days.map((day: DailyAgg): [string, number] => [day.date, day.focusMs])).toEqual([
      [futureDate, 120_000],
    ]);
  });
});

describe('buildStats', () => {
  it('migrates legacy daily and monthly exact economy totals to zero', () => {
    const legacyDay: DailyAgg = daily(TODAY, {});
    const legacyMonth: MonthlyAgg = monthly(TODAY.slice(0, 7), {});
    delete legacyDay.pauseMsEarned;
    delete legacyDay.unlockMsSpent;
    delete legacyMonth.pauseMsEarned;
    delete legacyMonth.unlockMsSpent;

    const bundle: StatsBundle = buildStats(
      'devA',
      {
        [`agg:devA:${TODAY}`]: legacyDay,
        [`aggm:devA:${TODAY.slice(0, 7)}`]: legacyMonth,
      },
      [],
      14,
      NOW,
    );

    expect(bundle.days[0]).toMatchObject({ pauseMsEarned: 0, unlockMsSpent: 0 });
    expect(bundle.months[0]).toMatchObject({ pauseMsEarned: 0, unlockMsSpent: 0 });
  });

  it('rejects malformed sync aggregates without crashing the stats read', () => {
    const previousMonth: string = '2026-07';
    const syncItems: Record<string, unknown> = {
      [`agg:devA:${TODAY}`]: { ...daily(TODAY, {}), attempts: null },
      [`agg:devB:${TODAY}`]: { ...daily(TODAY, {}), focusMs: 'one' },
      [`agg:devC:${TODAY}`]: { ...daily(YESTERDAY, {}) },
      [`aggm:devA:${TODAY.slice(0, 7)}`]: {
        ...monthly(TODAY.slice(0, 7), {}),
        attempts: null,
      },
      [`aggm:devB:${previousMonth}`]: { ...monthly(previousMonth, {}), resisted: 'many' },
      [`aggm:devC:${previousMonth}`]: { ...monthly(TODAY.slice(0, 7), {}) },
    };

    expect((): StatsBundle => buildStats('devA', syncItems, [], 60, NOW)).not.toThrow();
    const bundle: StatsBundle = buildStats('devA', syncItems, [], 60, NOW);
    expect(bundle.days).toEqual([]);
    expect(bundle.months).toEqual([]);
  });

  it('rejects a malformed synced streak without dropping valid aggregates', () => {
    const aggregate: DailyAgg = daily(TODAY, { focusMs: 60_000 });
    const bundle: StatsBundle = buildStats(
      'devA',
      {
        [SYNC_STREAK]: { current: 4 },
        [`agg:devA:${TODAY}`]: aggregate,
      },
      [],
      14,
      NOW,
    );

    expect(bundle.streak).toEqual(zeroStreak);
    expect(bundle.days).toEqual([aggregate]);
  });

  it('rejects a malformed synced streak before choosing against the live overlay', () => {
    const liveStreak: StreakState = {
      ...zeroStreak,
      current: 5,
      lastCountedDate: '2026-08-28',
      activeDays: [24, 25, 26, 27, 28],
    };
    let bundle: StatsBundle | undefined;

    expect((): void => {
      bundle = buildStats(
        'devA',
        {
          [SYNC_STREAK]: {
            current: 4,
            freezeTokens: 0,
            lastCountedDate: liveStreak.lastCountedDate,
            lastFreezeGrantDate: null,
            activeDays: null,
            activeMonth: liveStreak.activeMonth,
          },
        },
        [],
        14,
        NOW,
        {
          deviceId: 'devA',
          todayAgg: daily(TODAY, {}),
          streak: liveStreak,
          pendingEvents: [],
        },
      );
    }).not.toThrow();
    expect(bundle?.streak).toEqual(liveStreak);
  });

  it('keeps a newer synced streak over a stale in-memory overlay', () => {
    const synced: StreakState = {
      ...zeroStreak,
      current: 5,
      lastCountedDate: '2026-08-28',
      activeDays: [24, 25, 26, 27, 28],
    };
    const staleLocal: StreakState = {
      ...zeroStreak,
      current: 4,
      lastCountedDate: '2026-08-27',
      activeDays: [24, 25, 26, 27],
    };

    const bundle: StatsBundle = buildStats('devA', { [SYNC_STREAK]: synced }, [], 14, NOW, {
      deviceId: 'devA',
      todayAgg: daily(TODAY, {}),
      streak: staleLocal,
      pendingEvents: [],
    });

    expect(bundle.streak).toEqual(synced);
  });

  it('keeps a newer in-memory streak while its sync write is debounced', () => {
    const staleSync: StreakState = {
      ...zeroStreak,
      current: 4,
      lastCountedDate: '2026-08-27',
      activeDays: [24, 25, 26, 27],
    };
    const newerLocal: StreakState = {
      ...zeroStreak,
      current: 5,
      lastCountedDate: '2026-08-28',
      activeDays: [24, 25, 26, 27, 28],
    };

    const bundle: StatsBundle = buildStats('devA', { [SYNC_STREAK]: staleSync }, [], 14, NOW, {
      deviceId: 'devA',
      todayAgg: daily(TODAY, {}),
      streak: newerLocal,
      pendingEvents: [],
    });

    expect(bundle.streak).toEqual(newerLocal);
  });

  it('prefers sync when streak progress markers are equal', () => {
    const synced: StreakState = {
      ...zeroStreak,
      current: 5,
      lastCountedDate: '2026-08-28',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [24, 25, 26, 27, 28],
    };
    const local: StreakState = {
      ...synced,
      current: 4,
      activeDays: [24, 25, 26, 27],
    };

    const bundle: StatsBundle = buildStats('devA', { [SYNC_STREAK]: synced }, [], 14, NOW, {
      deviceId: 'devA',
      todayAgg: daily(TODAY, {}),
      streak: local,
      pendingEvents: [],
    });

    expect(bundle.streak).toEqual(synced);
  });

  it('replaces debounced sync data with the current in-memory aggregate', () => {
    const stale: DailyAgg = daily(TODAY, { focusMs: 1, resisted: 0 });
    const current: DailyAgg = daily(TODAY, { focusMs: 60_000, resisted: 1 });

    const bundle: StatsBundle = buildStats('devA', { [`agg:devA:${TODAY}`]: stale }, [], 14, NOW, {
      deviceId: 'devA',
      todayAgg: current,
      streak: null,
      pendingEvents: [],
    });

    expect(bundle.totals.focusMsToday).toBe(60_000);
    expect(bundle.totals.resistedToday).toBe(1);
  });

  it('merges same-day aggs across devices additively, totals count today only', () => {
    const syncItems: Record<string, unknown> = {
      [`agg:devA:${TODAY}`]: daily(TODAY, { focusMs: 60_000, attempts: { 'x.com': 2 } }),
      [`agg:devB:${TODAY}`]: daily(TODAY, {
        focusMs: 120_000,
        attempts: { 'x.com': 1, 'y.com': 3 },
        resisted: 2,
      }),
      [`agg:devA:${YESTERDAY}`]: daily(YESTERDAY, { focusMs: 300_000 }),
      settings: { unrelated: true },
    };
    const events: EventRecord[] = [
      {
        t: 'sessionStarted',
        at: 1,
        source: 'manual',
        mode: 'blacklist',
        strictness: 'friction',
        durationMin: 25,
        intention: '',
        sessionId: 'session-one',
      },
      { t: 'pauseTaken', at: 2, ms: 60_000, sessionId: 'session-one' },
      { t: 'unlockTaken', at: 3, host: 'x.com', ms: 30_000, sessionId: 'session-one' },
      { t: 'attempt', at: 4, url: 'https://x.com/', host: 'x.com', tabId: 1, kind: 'navigation' },
      { t: 'sessionCompleted', at: 5, focusedMs: 60_000, sessionId: 'session-one' },
    ];
    const bundle: StatsBundle = buildStats('devA', syncItems, events, 14, NOW);
    expect(bundle.days.map((d: DailyAgg): string => d.date)).toEqual([YESTERDAY, TODAY]);
    expect(bundle.days[1]?.focusMs).toBe(180_000);
    expect(bundle.days[1]?.attempts).toEqual({ 'x.com': 3, 'y.com': 3 });
    expect(bundle.totals.focusMsToday).toBe(180_000);
    expect(bundle.totals.focusMsWeek).toBe(480_000);
    expect(bundle.totals.attemptsToday).toBe(6);
    expect(bundle.totals.resistedToday).toBe(2);
    expect(bundle.recentSessions.map((e: EventRecord): string => e.t)).toEqual([
      'sessionCompleted',
      'unlockTaken',
      'pauseTaken',
      'sessionStarted',
    ]);
  });
});

describe('pruneAndRollup', () => {
  it('bounds retained clock-rebase archives per device', () => {
    const syncItems: Record<string, unknown> = {};
    for (let index: number = 0; index < 22; index++) {
      const at: number = NOW - index;
      syncItems[clockRebaseArchiveKey('devA', TODAY, at)] = daily(TODAY, {
        focusMs: index,
      });
    }

    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup('devA', syncItems, 90, NOW);

    expect(plan.remove).toHaveLength(2);
    expect(plan.remove).toContain(clockRebaseArchiveKey('devA', TODAY, NOW - 21));
    expect(plan.remove).toContain(clockRebaseArchiveKey('devA', TODAY, NOW - 20));
  });

  it('rolls a 91-day-old daily of this device into its monthly item and removes the key', () => {
    const oldDate: string = localDateStr(NOW - 91 * DAY_MS);
    const oldMonth: string = oldDate.slice(0, 7);
    const syncItems: Record<string, unknown> = {
      [`agg:devA:${oldDate}`]: daily(oldDate, { focusMs: 45_000 }),
      [`agg:devB:${oldDate}`]: daily(oldDate, { focusMs: 999 }),
      [`agg:devA:${TODAY}`]: daily(TODAY, { focusMs: 60_000 }),
    };
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup('devA', syncItems, 90, NOW);
    expect(plan.remove).toEqual([`agg:devA:${oldDate}`]);
    const rolled = plan.set[`aggm:devA:${oldMonth}`] as MonthlyAgg;
    expect(rolled.focusMs).toBe(45_000);
    expect(Object.keys(plan.set)).toEqual([`aggm:devA:${oldMonth}`]);
  });

  it('merges into an existing monthly item', () => {
    const oldDate: string = localDateStr(NOW - 91 * DAY_MS);
    const oldMonth: string = oldDate.slice(0, 7);
    const existing: MonthlyAgg = {
      month: oldMonth,
      focusMs: 10_000,
      sessionsStarted: 0,
      sessionsCompleted: 0,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      unlocksTaken: 0,
      resisted: 0,
    };
    const syncItems: Record<string, unknown> = {
      [`agg:devA:${oldDate}`]: daily(oldDate, { focusMs: 45_000 }),
      [`aggm:devA:${oldMonth}`]: existing,
    };
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup('devA', syncItems, 90, NOW);
    expect((plan.set[`aggm:devA:${oldMonth}`] as MonthlyAgg).focusMs).toBe(55_000);
  });
});

describe('applyPrunePlan', () => {
  afterEach((): void => {
    vi.unstubAllGlobals();
  });

  it('resumes a partially applied prune without adding the daily twice', async () => {
    const oldKey = 'agg:devA:2026-05-01';
    const monthKey = 'aggm:devA:2026-05';
    const state: Record<string, unknown> = {
      [oldKey]: daily('2026-05-01', { focusMs: 5 }),
      [monthKey]: monthly('2026-05', { focusMs: 10 }),
    };
    const sync: Record<string, unknown> = {
      get: vi.fn(
        async (key: string | null): Promise<Record<string, unknown>> =>
          key === null ? structuredClone(state) : { [key]: state[key] },
      ),
      getBytesInUse: vi.fn(
        async (): Promise<number> =>
          Object.entries(state).reduce(
            (total: number, [key, value]: [string, unknown]): number =>
              total + syncItemBytes(key, value),
            0,
          ),
      ),
      set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
        Object.assign(state, items);
      }),
      remove: vi
        .fn()
        .mockRejectedValueOnce(new Error('remove failed'))
        .mockImplementation(async (keys: string | string[]): Promise<void> => {
          for (const key of typeof keys === 'string' ? [keys] : keys) delete state[key];
        }),
    };
    vi.stubGlobal('chrome', { storage: { sync } });
    const plan = pruneAndRollup('devA', state, 90, NOW);

    await expect(applyPrunePlan('devA', plan)).rejects.toThrow('remove failed');
    await applyPrunePlan('devA', plan);

    expect((state[monthKey] as MonthlyAgg).focusMs).toBe(15);
    expect(state[oldKey]).toBeUndefined();
    expect(Object.keys(state).filter((key: string): boolean => key.startsWith('prune:'))).toEqual(
      [],
    );
  });

  it('compacts oldest monthly history before the prune checkpoint would exceed total quota', async () => {
    const oldKey: string = 'agg:devA:2026-05-01';
    const monthKey: string = 'aggm:devA:2026-05';
    const evictedMonthKey: string = 'aggm:devB:2024-01';
    const state: Record<string, unknown> = {
      [oldKey]: daily('2026-05-01', { focusMs: 5 }),
      [evictedMonthKey]: 'm'.repeat(4_000),
    };
    for (let index: number = 0; index < 12; index++) {
      state[`agg:devB:2026-08-${String(index + 1).padStart(2, '0')}`] = 'd'.repeat(7_600);
    }
    const bytesBeforePadding: number = Object.entries(state).reduce(
      (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
      0,
    );
    const paddingKey: string = 'settings';
    const paddingLength: number =
      SYNC_QUOTA_BYTES_TOTAL - 100 - bytesBeforePadding - syncItemBytes(paddingKey, '');
    state[paddingKey] = 'p'.repeat(paddingLength);
    const trace: string[] = [];
    const sync: Record<string, unknown> = {
      get: vi.fn(async (keys: string | string[] | null): Promise<Record<string, unknown>> => {
        if (keys === null) return structuredClone(state);
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        return Object.fromEntries(
          requested
            .filter((key: string): boolean => Object.hasOwn(state, key))
            .map((key: string): [string, unknown] => [key, structuredClone(state[key])]),
        );
      }),
      getBytesInUse: vi.fn(
        async (): Promise<number> =>
          Object.entries(state).reduce(
            (total: number, [key, value]: [string, unknown]): number =>
              total + syncItemBytes(key, value),
            0,
          ),
      ),
      set: vi.fn(async (items: Record<string, unknown>): Promise<void> => {
        const projected: Record<string, unknown> = { ...state, ...structuredClone(items) };
        const projectedBytes: number = Object.entries(projected).reduce(
          (total: number, [key, value]: [string, unknown]): number =>
            total + syncItemBytes(key, value),
          0,
        );
        if (projectedBytes > SYNC_QUOTA_BYTES_TOTAL) throw new Error('QUOTA_BYTES exceeded');
        trace.push(`set:${Object.keys(items).sort().join(',')}`);
        Object.assign(state, structuredClone(items));
      }),
      remove: vi.fn(async (keys: string | string[]): Promise<void> => {
        const requested: string[] = typeof keys === 'string' ? [keys] : keys;
        trace.push(`remove:${requested.join(',')}`);
        for (const key of requested) delete state[key];
      }),
    };
    vi.stubGlobal('chrome', { storage: { sync } });
    const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup('devA', state, 90, NOW);

    await applyPrunePlan('devA', plan);

    expect(trace).toEqual([
      `remove:${evictedMonthKey}`,
      `set:${monthKey},prune:devA`,
      `remove:${oldKey}`,
      'remove:prune:devA',
    ]);
    expect(state[monthKey]).toMatchObject({ focusMs: 5 });
    expect(state[oldKey]).toBeUndefined();
  });
});
