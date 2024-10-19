import type { ScheduleEntry } from '../shared/types';

const TIME_RE: RegExp = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm: string): number {
  const m: RegExpMatchArray | null = hhmm.match(TIME_RE);
  if (m === null) return Number.NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function validateEntry(entry: ScheduleEntry): string | null {
  if (Number.isNaN(toMinutes(entry.start)) || Number.isNaN(toMinutes(entry.end))) {
    return 'times must be HH:MM (24 hour)';
  }
  if (toMinutes(entry.start) >= toMinutes(entry.end)) return 'start must be before end';
  if (entry.days.length === 0 || entry.days.some((d: number): boolean => d < 0 || d > 6)) {
    return 'pick at least one day';
  }
  return null;
}

/** Entry whose window contains the local wall-clock time, null otherwise. */
export function activeEntry(entries: ScheduleEntry[], at: Date): ScheduleEntry | null {
  const nowMin: number = at.getHours() * 60 + at.getMinutes();
  const day: number = at.getDay();
  for (const e of entries) {
    if (!e.enabled || !e.days.includes(day)) continue;
    if (nowMin >= toMinutes(e.start) && nowMin < toMinutes(e.end)) return e;
  }
  return null;
}

/** End of the active window as an absolute Date. */
export function windowEnd(entry: ScheduleEntry, at: Date): Date {
  const end: number = toMinutes(entry.end);
  return new Date(at.getFullYear(), at.getMonth(), at.getDate(), Math.floor(end / 60), end % 60);
}

/** Next window start strictly after `at`, looking up to 8 days ahead. */
export function nextStart(
  entries: ScheduleEntry[],
  at: Date,
): { entry: ScheduleEntry; startsAt: Date } | null {
  let best: { entry: ScheduleEntry; startsAt: Date } | null = null;
  for (const e of entries) {
    if (!e.enabled) continue;
    const startMin: number = toMinutes(e.start);
    for (let d = 0; d < 8; d++) {
      const day: Date = new Date(at.getFullYear(), at.getMonth(), at.getDate() + d);
      if (!e.days.includes(day.getDay())) continue;
      const startsAt: Date = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        Math.floor(startMin / 60),
        startMin % 60,
      );
      if (startsAt.getTime() <= at.getTime()) continue;
      if (best === null || startsAt.getTime() < best.startsAt.getTime())
        best = { entry: e, startsAt };
      break;
    }
  }
  return best;
}
