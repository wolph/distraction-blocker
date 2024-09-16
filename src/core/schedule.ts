import type { ScheduleEntry } from '../shared/types';

export function validateEntry(entry: ScheduleEntry): string | null {
  throw new Error('not implemented, plan 02');
}

/** Entry whose window contains the local wall-clock time, null otherwise. */
export function activeEntry(entries: ScheduleEntry[], at: Date): ScheduleEntry | null {
  throw new Error('not implemented, plan 02');
}

/** End of the active window as an absolute Date. */
export function windowEnd(entry: ScheduleEntry, at: Date): Date {
  throw new Error('not implemented, plan 02');
}

/** Next window start strictly after `at`, looking up to 8 days ahead. */
export function nextStart(
  entries: ScheduleEntry[],
  at: Date,
): { entry: ScheduleEntry; startsAt: Date } | null {
  throw new Error('not implemented, plan 02');
}
