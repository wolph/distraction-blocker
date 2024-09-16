import type { StreakState } from '../shared/types';

export function emptyStreak(month: string): StreakState {
  throw new Error('not implemented, plan 02');
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
  throw new Error('not implemented, plan 02');
}
