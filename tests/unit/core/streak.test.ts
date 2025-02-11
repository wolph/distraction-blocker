import { describe, expect, it } from 'vitest';
import { closeDay, emptyStreak } from '../../../src/core/streak';
import type { StreakState } from '../../../src/shared/types';

describe('closeDay', () => {
  it('goal met extends the chain and records the active day', () => {
    const s: StreakState = closeDay(emptyStreak('2026-08'), '2026-08-25', 30, 25, 7);
    expect(s.current).toBe(1);
    expect(s.activeDays).toEqual([25]);
    expect(s.lastCountedDate).toBe('2026-08-25');
  });
  it('goal missed with a token spends it and keeps the chain', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 4, freezeTokens: 1 };
    const s: StreakState = closeDay(base, '2026-08-25', 0, 25, 7);
    expect(s.current).toBe(4);
    expect(s.freezeTokens).toBe(0);
    expect(s.activeDays).toEqual([]);
  });
  it('goal missed without a token resets', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 9, freezeTokens: 0 };
    expect(closeDay(base, '2026-08-25', 0, 25, 7).current).toBe(0);
  });
  it('anchors a missing grant date without granting, then follows the calendar-day cadence', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), freezeTokens: 0 };
    const anchored: StreakState = closeDay(base, '2026-08-26', 30, 25, 7);
    const early: StreakState = closeDay(anchored, '2026-09-01', 30, 25, 7);
    const due: StreakState = closeDay(early, '2026-09-02', 30, 25, 7);

    expect(anchored).toMatchObject({ freezeTokens: 0, lastFreezeGrantDate: '2026-08-26' });
    expect(early).toMatchObject({ freezeTokens: 0, lastFreezeGrantDate: '2026-08-26' });
    expect(due).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-09-02' });
  });

  it('uses UTC calendar dates across DST and honors a custom interval', () => {
    const base: StreakState = {
      ...emptyStreak('2026-03'),
      freezeTokens: 0,
      lastFreezeGrantDate: '2026-03-22',
    };

    const due: StreakState = closeDay(base, '2026-03-29', 30, 25, 7);
    const custom: StreakState = closeDay(
      { ...base, lastFreezeGrantDate: '2026-03-26' },
      '2026-03-29',
      30,
      25,
      3,
    );

    expect(due).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-03-29' });
    expect(custom).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-03-29' });
  });

  it('grants at most once per closed day during sequential catch-up', () => {
    const base: StreakState = {
      ...emptyStreak('2026-08'),
      lastFreezeGrantDate: '2026-08-24',
    };
    const first: StreakState = closeDay(base, '2026-08-25', 30, 25, 1);
    const repeated: StreakState = closeDay(first, '2026-08-25', 30, 25, 1);
    const second: StreakState = closeDay(repeated, '2026-08-26', 30, 25, 1);
    const capped: StreakState = closeDay(second, '2026-08-27', 30, 25, 1);

    expect(first.freezeTokens).toBe(1);
    expect(repeated).toEqual(first);
    expect(second.freezeTokens).toBe(2);
    expect(capped).toMatchObject({ freezeTokens: 2, lastFreezeGrantDate: '2026-08-27' });
  });
  it('a new month resets activeDays, not the chain', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 5, activeDays: [25, 26] };
    const s: StreakState = closeDay(base, '2026-09-01', 30, 25, 7);
    expect(s.activeMonth).toBe('2026-09');
    expect(s.activeDays).toEqual([1]);
    expect(s.current).toBe(6);
  });
  it('closing the same date twice is a no-op', () => {
    const once: StreakState = closeDay(emptyStreak('2026-08'), '2026-08-25', 30, 25, 7);
    expect(closeDay(once, '2026-08-25', 30, 25, 7)).toEqual(once);
  });

  it('ignores a stale date older than the synced last-counted date', () => {
    const synced: StreakState = {
      ...emptyStreak('2026-08'),
      current: 12,
      freezeTokens: 2,
      lastCountedDate: '2026-08-25',
      lastFreezeGrantDate: '2026-08-24',
      activeDays: [23, 24, 25],
    };

    expect(closeDay(synced, '2026-08-20', 0, 25, 7)).toEqual(synced);
  });
});
