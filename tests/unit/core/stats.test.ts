import { describe, expect, it } from 'vitest';
import {
  addEvent,
  capAttempts,
  emptyDaily,
  mergeDaily,
  rollupMonth,
} from '../../../src/core/stats';
import type { DailyAgg } from '../../../src/shared/types';

const AT = 1_000;

describe('addEvent', () => {
  it('folds the aggregating events and ignores the rest', () => {
    let agg: DailyAgg = emptyDaily('2026-08-28');
    agg = addEvent(agg, {
      t: 'sessionStarted',
      at: AT,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'hard',
      durationMin: 25,
      intention: '',
    });
    agg = addEvent(agg, {
      t: 'attempt',
      at: AT,
      url: 'https://x.com/',
      host: 'x.com',
      tabId: 1,
      kind: 'navigation',
    });
    agg = addEvent(agg, {
      t: 'attempt',
      at: AT,
      url: 'https://x.com/',
      host: 'x.com',
      tabId: 1,
      kind: 'existing',
    });
    agg = addEvent(agg, { t: 'gateResisted', at: AT, gate: 'pause' });
    agg = addEvent(agg, { t: 'budgetEarned', at: AT, ms: 125_500 });
    agg = addEvent(agg, { t: 'pauseTaken', at: AT, ms: 300_000 });
    agg = addEvent(agg, { t: 'unlockTaken', at: AT, host: 'x.com', ms: 90_000 });
    agg = addEvent(agg, { t: 'sessionCanceled', at: AT, focusedMs: 600_000 });
    agg = addEvent(agg, { t: 'phase', at: AT, from: 'focus', to: 'break' });
    expect(agg.sessionsStarted).toBe(1);
    expect(agg.attempts).toEqual({ 'x.com': 2 });
    expect(agg.resisted).toBe(1);
    expect(agg.pausesTaken).toBe(1);
    expect(agg.pauseMsSpent).toBe(300_000);
    expect(agg.pauseMsEarned).toBe(125_500);
    expect(agg.unlockMsSpent).toBe(90_000);
    expect(agg.focusMs).toBe(600_000);
    expect(agg.sessionsCompleted).toBe(0);
  });
});

describe('mergeDaily', () => {
  it('adds two devices of the same day', () => {
    const a: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      focusMs: 10,
      attempts: { 'x.com': 1 },
      attemptsOther: 2,
    };
    const b: DailyAgg = {
      ...emptyDaily('2026-08-28'),
      focusMs: 5,
      pauseMsEarned: 20,
      unlockMsSpent: 7,
      attempts: { 'x.com': 2, 'nu.nl': 1 },
    };
    a.pauseMsEarned = 10;
    a.unlockMsSpent = 3;
    const m: DailyAgg = mergeDaily([a, b]);
    expect(m.focusMs).toBe(15);
    expect(m.attempts).toEqual({ 'x.com': 3, 'nu.nl': 1 });
    expect(m.attemptsOther).toBe(2);
    expect(m.pauseMsEarned).toBe(30);
    expect(m.unlockMsSpent).toBe(10);
  });

  it('migrates missing exact economy fields to zero', () => {
    const legacy: DailyAgg = emptyDaily('2026-08-28');
    delete legacy.pauseMsEarned;
    delete legacy.unlockMsSpent;

    expect(mergeDaily([legacy])).toMatchObject({ pauseMsEarned: 0, unlockMsSpent: 0 });
  });
});

describe('capAttempts', () => {
  it('keeps topN by count then name, folds the rest', () => {
    const agg: DailyAgg = { ...emptyDaily('2026-08-28'), attempts: { a: 5, b: 3, c: 3, d: 1 } };
    const capped: DailyAgg = capAttempts(agg, 2);
    expect(capped.attempts).toEqual({ a: 5, b: 3 });
    expect(capped.attemptsOther).toBe(4);
  });
});

describe('rollupMonth', () => {
  it('sums dailies and caps hosts', () => {
    const d1: DailyAgg = {
      ...emptyDaily('2026-08-01'),
      focusMs: 10,
      pauseMsEarned: 4,
      unlockMsSpent: 2,
      attempts: { a: 1 },
    };
    const d2: DailyAgg = {
      ...emptyDaily('2026-08-02'),
      focusMs: 20,
      pauseMsEarned: 6,
      unlockMsSpent: 3,
      attempts: { a: 2, b: 9 },
    };
    const m = rollupMonth('2026-08', [d1, d2]);
    expect(m.month).toBe('2026-08');
    expect(m.focusMs).toBe(30);
    expect(m.attempts.a).toBe(3);
    expect(m.attempts.b).toBe(9);
    expect(m.pauseMsEarned).toBe(10);
    expect(m.unlockMsSpent).toBe(5);
  });
});
