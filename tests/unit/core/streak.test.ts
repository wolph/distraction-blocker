import { describe, expect, it } from 'vitest';
import { closeDay, emptyStreak } from '../../../src/core/streak';
import type { StreakState } from '../../../src/shared/types';

// 2026-08-24 is a Monday.
describe('closeDay', () => {
  it('goal met extends the chain and records the active day', () => {
    const s = closeDay(emptyStreak('2026-08'), '2026-08-25', 30, 25);
    expect(s.current).toBe(1);
    expect(s.activeDays).toEqual([25]);
    expect(s.lastCountedDate).toBe('2026-08-25');
  });
  it('goal missed with a token spends it and keeps the chain', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 4, freezeTokens: 1 };
    const s = closeDay(base, '2026-08-25', 0, 25);
    expect(s.current).toBe(4);
    expect(s.freezeTokens).toBe(0);
    expect(s.activeDays).toEqual([]);
  });
  it('goal missed without a token resets', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 9, freezeTokens: 0 };
    expect(closeDay(base, '2026-08-25', 0, 25).current).toBe(0);
  });
  it('Mondays grant one token, capped at 2, once per Monday', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), freezeTokens: 0 };
    const monday = closeDay(base, '2026-08-24', 30, 25);
    expect(monday.freezeTokens).toBe(1);
    expect(closeDay(monday, '2026-08-24', 30, 25).freezeTokens).toBe(1);
    const maxed: StreakState = { ...monday, freezeTokens: 2 };
    expect(closeDay(maxed, '2026-08-31', 30, 25).freezeTokens).toBe(2);
  });
  it('a new month resets activeDays, not the chain', () => {
    const base: StreakState = { ...emptyStreak('2026-08'), current: 5, activeDays: [25, 26] };
    const s = closeDay(base, '2026-09-01', 30, 25);
    expect(s.activeMonth).toBe('2026-09');
    expect(s.activeDays).toEqual([1]);
    expect(s.current).toBe(6);
  });
  it('closing the same date twice is a no-op', () => {
    const once = closeDay(emptyStreak('2026-08'), '2026-08-25', 30, 25);
    expect(closeDay(once, '2026-08-25', 30, 25)).toEqual(once);
  });
});
