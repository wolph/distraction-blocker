import { MAX_FREEZE_TOKENS } from '../shared/constants';
import type { StreakState } from '../shared/types';

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

// Noon avoids any DST edge: the calendar day of a YYYY-MM-DD string is
// what matters here, not a clock reading.
function isMonday(date: string): boolean {
  return new Date(`${date}T12:00:00`).getDay() === 1;
}

/**
 * Called once per local-day rollover with the finished day's focus
 * minutes. Handles: goal met (streak +1, active day recorded), goal
 * missed with a freeze token (token spent, streak kept), goal missed
 * without one (streak reset), Monday token grant (max 2), month change
 * (activeDays reset to the new month).
 */
export function closeDay(
  streak: StreakState,
  date: string,
  focusMin: number,
  goalMin: number,
): StreakState {
  if (streak.lastCountedDate === date) return streak;
  const month: string = date.slice(0, 7);
  let s: StreakState = { ...streak, activeDays: [...streak.activeDays] };
  if (s.activeMonth !== month) s = { ...s, activeMonth: month, activeDays: [] };
  if (isMonday(date) && s.lastFreezeGrantDate !== date) {
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
