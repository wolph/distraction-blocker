import { describe, expect, it, vi } from 'vitest';
import { planRollover, type RolloverPlan } from '../../../src/background/rollover';
import { buildStats, pruneAndRollup } from '../../../src/background/stats-service';
import type { StatsBundle } from '../../../src/shared/messages';
import { localDateStr } from '../../../src/shared/time';
import type { DailyAgg, EventRecord, MonthlyAgg, StreakState } from '../../../src/shared/types';

// The real src/core modules still throw "not implemented" on this branch.
// These fakes implement just enough semantics to exercise the grouping,
// merging, and key handling that rollover.ts and stats-service.ts own.
// Delete once ws/core merges.
vi.mock('../../../src/core/stats', () => {
  function zero(date: string): DailyAgg {
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
    };
  }
  function addInto(
    into: Record<string, number>,
    from: Record<string, number>,
  ): Record<string, number> {
    const out: Record<string, number> = { ...into };
    const entries: Array<[string, number]> = Object.entries(from);
    for (let index: number = 0; index < entries.length; index++) {
      const entry: [string, number] = entries[index] as [string, number];
      const key: string = entry[0];
      const value: number = entry[1];
      out[key] = (out[key] ?? 0) + value;
    }
    return out;
  }
  return {
    emptyDaily: zero,
    addEvent: (agg: DailyAgg): DailyAgg => agg,
    mergeDaily: (sameDay: DailyAgg[]): DailyAgg => {
      let out: DailyAgg = zero(sameDay[0]?.date ?? '');
      for (let index: number = 0; index < sameDay.length; index++) {
        const day: DailyAgg = sameDay[index] as DailyAgg;
        out = {
          ...out,
          focusMs: out.focusMs + day.focusMs,
          sessionsStarted: out.sessionsStarted + day.sessionsStarted,
          sessionsCompleted: out.sessionsCompleted + day.sessionsCompleted,
          attempts: addInto(out.attempts, day.attempts),
          attemptsOther: out.attemptsOther + day.attemptsOther,
          pausesTaken: out.pausesTaken + day.pausesTaken,
          pauseMsSpent: out.pauseMsSpent + day.pauseMsSpent,
          unlocksTaken: out.unlocksTaken + day.unlocksTaken,
          resisted: out.resisted + day.resisted,
        };
      }
      return out;
    },
    mergeMonthly: (sameMonth: MonthlyAgg[]): MonthlyAgg => {
      let out: MonthlyAgg = {
        month: sameMonth[0]?.month ?? '',
        focusMs: 0,
        sessionsStarted: 0,
        sessionsCompleted: 0,
        attempts: {},
        attemptsOther: 0,
        pausesTaken: 0,
        pauseMsSpent: 0,
        unlocksTaken: 0,
        resisted: 0,
      };
      for (let index: number = 0; index < sameMonth.length; index++) {
        const month: MonthlyAgg = sameMonth[index] as MonthlyAgg;
        out = {
          ...out,
          focusMs: out.focusMs + month.focusMs,
          attempts: addInto(out.attempts, month.attempts),
        };
      }
      return out;
    },
    capAttempts: (agg: DailyAgg, topN: number): DailyAgg => {
      const sorted: Array<[string, number]> = Object.entries(agg.attempts).sort(
        (a: [string, number], b: [string, number]): number => b[1] - a[1],
      );
      const kept: Array<[string, number]> = sorted.slice(0, topN);
      const dropped: number = sorted
        .slice(topN)
        .reduce((a: number, [, v]: [string, number]): number => a + v, 0);
      return {
        ...agg,
        attempts: Object.fromEntries(kept),
        attemptsOther: agg.attemptsOther + dropped,
      };
    },
    rollupMonth: (month: string, dailies: DailyAgg[]): MonthlyAgg => ({
      month,
      focusMs: dailies.reduce((a: number, d: DailyAgg): number => a + d.focusMs, 0),
      sessionsStarted: 0,
      sessionsCompleted: 0,
      attempts: {},
      attemptsOther: 0,
      pausesTaken: 0,
      pauseMsSpent: 0,
      unlocksTaken: 0,
      resisted: 0,
    }),
  };
});

vi.mock('../../../src/core/streak', () => ({
  emptyStreak: (month: string): StreakState => ({
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: month,
  }),
  closeDay: (streak: StreakState, date: string, focusMin: number, goalMin: number): StreakState =>
    focusMin >= goalMin
      ? { ...streak, current: streak.current + 1, lastCountedDate: date }
      : { ...streak, current: 0 },
}));

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
