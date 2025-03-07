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
  it('keeps a fresh streak unanchored until the next Monday grant', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), freezeTokens: 0 };
    const beforeMonday: StreakState = closeDay(base, '2026-08-26', 30, 25, 7);
    const monday: StreakState = closeDay(beforeMonday, '2026-08-31', 30, 25, 7);

    expect(beforeMonday).toMatchObject({ freezeTokens: 0, lastFreezeGrantDate: null });
    expect(monday).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-08-31' });
  });

  it('uses calendar dates across DST and honors a custom minimum interval on Mondays', () => {
    const base: StreakState = {
      ...emptyStreak('2026-03'),
      freezeTokens: 0,
      lastFreezeGrantDate: '2026-03-23',
    };

    const due: StreakState = closeDay(base, '2026-03-30', 30, 25, 7);
    const custom: StreakState = closeDay(
      { ...base, lastFreezeGrantDate: '2026-03-26' },
      '2026-03-30',
      30,
      25,
      3,
    );

    expect(due).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-03-30' });
    expect(custom).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-03-30' });
  });

  it('grants at most once per Monday during sequential catch-up', () => {
    const base: StreakState = {
      ...emptyStreak('2026-08'),
      lastFreezeGrantDate: '2026-08-24',
    };
    const first: StreakState = closeDay(base, '2026-08-31', 30, 25, 1);
    const repeated: StreakState = closeDay(first, '2026-08-31', 30, 25, 1);
    const tuesday: StreakState = closeDay(repeated, '2026-09-01', 30, 25, 1);
    const second: StreakState = closeDay(tuesday, '2026-09-07', 30, 25, 1);
    const capped: StreakState = closeDay(second, '2026-09-14', 30, 25, 1);

    expect(first.freezeTokens).toBe(1);
    expect(repeated).toEqual(first);
    expect(tuesday).toMatchObject({ freezeTokens: 1, lastFreezeGrantDate: '2026-08-31' });
    expect(second.freezeTokens).toBe(2);
    expect(capped).toMatchObject({ freezeTokens: 2, lastFreezeGrantDate: '2026-09-14' });
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

  it('ignores a stale date older than the synced last-counted date', (): void => {
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
