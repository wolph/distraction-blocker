import { capAttempts, emptyDaily } from '../core/stats';
import { closeDay } from '../core/streak';
import { TOP_SITES_DAILY } from '../shared/constants';
import { localDateStr } from '../shared/time';
import type { DailyAgg, StreakState } from '../shared/types';

export interface RolloverPlan {
  /** the finished day, attempt hosts capped, ready to sync */
  finished: DailyAgg;
  /** the fresh aggregate for the new local date */
  newAgg: DailyAgg;
  streak: StreakState;
}

export interface BackwardDateRebasePlan {
  archive: DailyAgg;
  newAgg: DailyAgg;
}

/**
 * Pure midnight rollover: cap the finished day's attempt hosts, close
 * the streak day with its focus minutes, mint the new day's aggregate.
 * todayAgg is null when no event ever folded in that day.
 */
export function planRollover(
  prevDate: string,
  now: number,
  todayAgg: DailyAgg | null,
  streak: StreakState,
  goalMin: number,
): RolloverPlan {
  const finished: DailyAgg = capAttempts(todayAgg ?? emptyDaily(prevDate), TOP_SITES_DAILY);
  const focusMin: number = finished.focusMs / 60_000;
  const closed: StreakState = closeDay(streak, prevDate, focusMin, goalMin);
  const currentMonth: string = localDateStr(now).slice(0, 7);
  return {
    finished,
    newAgg: emptyDaily(localDateStr(now)),
    streak:
      closed.activeMonth === currentMonth
        ? closed
        : { ...closed, activeMonth: currentMonth, activeDays: [] },
  };
}

export function planBackwardDateRebase(
  currentDate: string,
  futureAgg: DailyAgg,
): BackwardDateRebasePlan {
  return {
    archive: capAttempts(futureAgg, TOP_SITES_DAILY),
    newAgg: emptyDaily(currentDate),
  };
}
