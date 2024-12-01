import type { StreakState } from '../shared/types';

function compareMarker(left: string | null, right: string | null): number {
  return (left ?? '').localeCompare(right ?? '');
}

/** Sync wins ties so a stale worker cannot replace cross-instance progress. */
export function chooseNewerStreak(
  synced: StreakState | null,
  local: StreakState | null,
): StreakState | null {
  if (synced === null) return local;
  if (local === null) return synced;

  const countedComparison: number = compareMarker(local.lastCountedDate, synced.lastCountedDate);
  if (countedComparison !== 0) return countedComparison > 0 ? local : synced;

  const freezeComparison: number = compareMarker(
    local.lastFreezeGrantDate,
    synced.lastFreezeGrantDate,
  );
  if (freezeComparison !== 0) return freezeComparison > 0 ? local : synced;

  const monthComparison: number = local.activeMonth.localeCompare(synced.activeMonth);
  if (monthComparison !== 0) return monthComparison > 0 ? local : synced;
  return {
    ...synced,
    current: Math.max(synced.current, local.current),
    freezeTokens: Math.max(synced.freezeTokens, local.freezeTokens),
    activeDays: [...new Set([...synced.activeDays, ...local.activeDays])].sort(
      (left: number, right: number): number => left - right,
    ),
  };
}

export function streaksEqual(left: StreakState, right: StreakState): boolean {
  return (
    left.current === right.current &&
    left.freezeTokens === right.freezeTokens &&
    left.lastCountedDate === right.lastCountedDate &&
    left.lastFreezeGrantDate === right.lastFreezeGrantDate &&
    left.activeMonth === right.activeMonth &&
    left.activeDays.length === right.activeDays.length &&
    left.activeDays.every((day: number, index: number): boolean => day === right.activeDays[index])
  );
}

export function rebaseStreakForDate(streak: StreakState, today: string): StreakState {
  const month: string = today.slice(0, 7);
  const day: number = Number(today.slice(8));
  const countedInFuture: boolean =
    streak.lastCountedDate !== null && streak.lastCountedDate > today;
  return {
    ...streak,
    current: countedInFuture ? 0 : streak.current,
    lastCountedDate: countedInFuture ? null : streak.lastCountedDate,
    lastFreezeGrantDate:
      streak.lastFreezeGrantDate !== null && streak.lastFreezeGrantDate > today
        ? null
        : streak.lastFreezeGrantDate,
    activeMonth: month,
    activeDays:
      streak.activeMonth === month
        ? streak.activeDays.filter((activeDay: number): boolean => activeDay <= day)
        : [],
  };
}
