import { afterEach, describe, expect, it, vi } from 'vitest';
import { planRollover, type RolloverPlan } from '../../../src/background/rollover';
import { applyPrunePlan, buildStats, pruneAndRollup } from '../../../src/background/stats-service';
import type { StatsBundle } from '../../../src/shared/messages';
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
    unlocksTaken: 0,
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
    unlocksTaken: 0,
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
});

describe('buildStats', () => {
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
      },
      { t: 'attempt', at: 2, url: 'https://x.com/', host: 'x.com', tabId: 1, kind: 'navigation' },
      { t: 'sessionCompleted', at: 3, focusedMs: 60_000 },
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
      'sessionStarted',
    ]);
  });
});

describe('pruneAndRollup', () => {
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
    const sync = {
      get: vi.fn(async (key: string): Promise<Record<string, unknown>> => ({ [key]: state[key] })),
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
});
