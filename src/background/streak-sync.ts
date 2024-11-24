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
  return monthComparison > 0 ? local : synced;
}
