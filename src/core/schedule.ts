import type { NormalizedScheduleEntryV1 } from '../shared/types';

const TIME_RE: RegExp = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm: string): number {
  const m: RegExpMatchArray | null = hhmm.match(TIME_RE);
  if (m === null) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function validateEntry(entry: NormalizedScheduleEntryV1): string | null {
  if (Number.isNaN(toMinutes(entry.start)) || Number.isNaN(toMinutes(entry.end))) {
    return 'times must be HH:MM (24 hour)';
  }
  if (toMinutes(entry.start) >= toMinutes(entry.end)) return 'start must be before end';
  if (entry.days.length === 0 || entry.days.some((d: number): boolean => d < 0 || d > 6)) {
    return 'pick at least one day';
  }
  return null;
}

export function scheduleEntriesOverlap(
  first: NormalizedScheduleEntryV1,
  second: NormalizedScheduleEntryV1,
): boolean {
  if (!first.enabled || !second.enabled || first.id === second.id) return false;
  const sharedDay: boolean = first.days.some((day: number): boolean => second.days.includes(day));
  return sharedDay && first.start < second.end && second.start < first.end;
}

/** End of the active window as an absolute Date. */
export function windowEnd(entry: NormalizedScheduleEntryV1, at: Date): Date {
  const end: number = toMinutes(entry.end);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(end / 60), end % 60);
}
