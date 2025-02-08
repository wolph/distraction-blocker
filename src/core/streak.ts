import { MAX_FREEZE_TOKENS } from '../shared/constants';
import type { StreakState } from '../shared/types';

const DAY_MS: number = 86_400_000;

export function emptyStreak(month: string): StreakState {
  return {
    current: 0,
    freezeTokens: 0,
    lastCountedDate: null,
    lastFreezeGrantDate: null,
    activeDays: [],
    activeMonth: month,
  };
}

function utcCalendarDay(date: string): number {
  const year: number = Number(date.slice(0, 4));
  const month: number = Number(date.slice(5, 7));
  const day: number = Number(date.slice(8, 10));
  return Date.UTC(year, month - 1, day) / DAY_MS;
}

function freezeGrantDue(lastGrantDate: string, date: string, intervalDays: number): boolean {
  return utcCalendarDay(date) - utcCalendarDay(lastGrantDate) >= intervalDays;
}

/**
 * Called once per local-day rollover with the finished day's focus
 * minutes. Handles: goal met (streak +1, active day recorded), goal
 * missed with a freeze token (token spent, streak kept), goal missed
 * without one (streak reset), elapsed-day token grant (max 2), month change
 * (activeDays reset to the new month).
 */
export function closeDay(
  streak: StreakState,
  date: string,
  focusMin: number,
  goalMin: number,
  freezeIntervalDays: number,
): StreakState {
  if (streak.lastCountedDate === date) return streak;
  const month: string = date.slice(0, 7);
  let s: StreakState = { ...streak, activeDays: [...streak.activeDays] };
  if (s.activeMonth !== month) s = { ...s, activeMonth: month, activeDays: [] };
  // Legacy and fresh streaks have no grant marker. Anchor the cadence on
  // the first closed date without minting an early token.
  if (s.lastFreezeGrantDate === null) {
    s = { ...s, lastFreezeGrantDate: date };
  } else if (freezeGrantDue(s.lastFreezeGrantDate, date, freezeIntervalDays)) {
    s = {
      ...s,
      freezeTokens: Math.min(MAX_FREEZE_TOKENS, s.freezeTokens + 1),
      lastFreezeGrantDate: date,
    };
  }
  if (focusMin >= goalMin) {
    s = { ...s, current: s.current + 1, activeDays: [...s.activeDays, Number(date.slice(8))] };
  } else if (s.freezeTokens > 0) {
    s = { ...s, freezeTokens: s.freezeTokens - 1 };
  } else {
    s = { ...s, current: 0 };
  }
  return { ...s, lastCountedDate: date };
}
