import { TOP_SITES_MONTHLY } from '../shared/constants';
import type { DailyAgg, EventRecord, MonthlyAgg } from '../shared/types';

/** The counter fields DailyAgg and MonthlyAgg share, used by the merge and cap helpers. */
interface AggCounters {
  focusMs: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  attempts: Record<string, number>;
  attemptsOther: number;
  pausesTaken: number;
  pauseMsSpent: number;
  pauseMsEarned?: number;
  unlocksTaken: number;
  unlockMsSpent?: number;
  resisted: number;
}

const DAILY_DATE_RE: RegExp = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE: RegExp = /^(\d{4})-(\d{2})$/;
const REQUIRED_COUNT_FIELDS: Array<keyof AggCounters> = [
  'sessionsStarted',
  'sessionsCompleted',
  'attemptsOther',
  'pausesTaken',
  'unlocksTaken',
  'resisted',
];
const REQUIRED_MS_FIELDS: Array<keyof AggCounters> = ['focusMs', 'pauseMsSpent'];

function isNonnegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonnegativeInteger(value: unknown): value is number {
  return isNonnegativeFinite(value) && Number.isInteger(value);
}

export function isDailyDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match: RegExpExecArray | null = DAILY_DATE_RE.exec(value);
  if (match === null) return false;
  const year: number = Number(match[1]);
  const month: number = Number(match[2]);
  const day: number = Number(match[3]);
  const parsed: Date = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function isMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match: RegExpExecArray | null = MONTH_RE.exec(value);
  if (match === null) return false;
  const month: number = Number(match[2]);
  return month >= 1 && month <= 12;
}

function parseCounters(value: unknown): AggCounters | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  for (const key of REQUIRED_COUNT_FIELDS) {
    if (!isNonnegativeInteger(candidate[key])) return null;
  }
  for (const key of REQUIRED_MS_FIELDS) {
    if (!isNonnegativeFinite(candidate[key])) return null;
  }
  const attemptsValue: unknown = candidate.attempts;
  if (typeof attemptsValue !== 'object' || attemptsValue === null || Array.isArray(attemptsValue)) {
    return null;
  }
  const attempts: Record<string, number> = {};
  for (const [host, count] of Object.entries(attemptsValue)) {
    if (!isNonnegativeInteger(count)) return null;
    attempts[host] = count;
  }
  const pauseMsEarned: unknown = candidate.pauseMsEarned ?? 0;
  const unlockMsSpent: unknown = candidate.unlockMsSpent ?? 0;
  if (!isNonnegativeFinite(pauseMsEarned) || !isNonnegativeFinite(unlockMsSpent)) return null;
  return {
    focusMs: candidate.focusMs as number,
    sessionsStarted: candidate.sessionsStarted as number,
    sessionsCompleted: candidate.sessionsCompleted as number,
    attempts,
    attemptsOther: candidate.attemptsOther as number,
    pausesTaken: candidate.pausesTaken as number,
    pauseMsSpent: candidate.pauseMsSpent as number,
    pauseMsEarned,
    unlocksTaken: candidate.unlocksTaken as number,
    unlockMsSpent,
    resisted: candidate.resisted as number,
  };
}

export function parseDailyAgg(value: unknown, expectedDate?: string): DailyAgg | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  if (
    !isDailyDate(candidate.date) ||
    (expectedDate !== undefined && candidate.date !== expectedDate)
  ) {
    return null;
  }
  const counters: AggCounters | null = parseCounters(candidate);
  return counters === null ? null : { date: candidate.date, ...counters };
}

export function parseMonthlyAgg(value: unknown, expectedMonth?: string): MonthlyAgg | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate: Record<string, unknown> = value as Record<string, unknown>;
  if (
    !isMonth(candidate.month) ||
    (expectedMonth !== undefined && candidate.month !== expectedMonth)
  ) {
    return null;
  }
  const counters: AggCounters | null = parseCounters(candidate);
  return counters === null ? null : { month: candidate.month, ...counters };
}

function normalizeCounters<T extends AggCounters>(agg: T): T {
  return {
    ...agg,
    pauseMsEarned: agg.pauseMsEarned ?? 0,
    unlockMsSpent: agg.unlockMsSpent ?? 0,
  };
}

function sumCounters<T extends AggCounters>(into: T, from: AggCounters): T {
  const attempts: Record<string, number> = { ...into.attempts };
  for (const [host, n] of Object.entries(from.attempts)) {
    attempts[host] = (attempts[host] ?? 0) + n;
  }
  return {
    ...into,
    focusMs: into.focusMs + from.focusMs,
    sessionsStarted: into.sessionsStarted + from.sessionsStarted,
    sessionsCompleted: into.sessionsCompleted + from.sessionsCompleted,
    attempts,
    attemptsOther: into.attemptsOther + from.attemptsOther,
    pausesTaken: into.pausesTaken + from.pausesTaken,
    pauseMsSpent: into.pauseMsSpent + from.pauseMsSpent,
    pauseMsEarned: (into.pauseMsEarned ?? 0) + (from.pauseMsEarned ?? 0),
    unlocksTaken: into.unlocksTaken + from.unlocksTaken,
    unlockMsSpent: (into.unlockMsSpent ?? 0) + (from.unlockMsSpent ?? 0),
    resisted: into.resisted + from.resisted,
  };
}

/** Deterministic top-N: count desc, then host asc. The tail folds into attemptsOther. */
function capCounters<T extends AggCounters>(agg: T, topN: number): T {
  const normalized: T = normalizeCounters(agg);
  const entries: Array<[string, number]> = Object.entries(normalized.attempts).sort(
    (a: [string, number], b: [string, number]): number => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const kept: Record<string, number> = {};
  let folded: number = 0;
  for (let i: number = 0; i < entries.length; i++) {
    const entry: [string, number] | undefined = entries[i];
    if (entry === undefined) continue;
    if (i < topN) kept[entry[0]] = entry[1];
    else folded += entry[1];
  }
  return {
    ...normalized,
    attempts: kept,
    attemptsOther: normalized.attemptsOther + folded,
  };
}

export function emptyDaily(date: string): DailyAgg {
  return {
    date,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
  };
}

function emptyMonthly(month: string): MonthlyAgg {
  return {
    month,
    focusMs: 0,
    sessionsStarted: 0,
    sessionsCompleted: 0,
    attempts: {},
    attemptsOther: 0,
    pausesTaken: 0,
    pauseMsSpent: 0,
    pauseMsEarned: 0,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 0,
  };
}

/** Folds one event into the day it belongs to. Ignores event kinds that do not aggregate. */
export function addEvent(agg: DailyAgg, ev: EventRecord): DailyAgg {
  const current: DailyAgg = normalizeCounters(agg);
  switch (ev.t) {
    case 'sessionStarted':
      return { ...current, sessionsStarted: current.sessionsStarted + 1 };
    case 'sessionCompleted':
      return {
        ...current,
        sessionsCompleted: current.sessionsCompleted + 1,
        focusMs: current.focusMs + ev.focusedMs,
      };
    case 'sessionCanceled':
      // Canceled sessions still contribute the focus they achieved.
      return { ...current, focusMs: current.focusMs + ev.focusedMs };
    // One v2 end event carries the outcome the two legacy events split between them.
    case 'sessionEnded':
      return ev.outcome === 'completed'
        ? {
            ...current,
            sessionsCompleted: current.sessionsCompleted + 1,
            focusMs: current.focusMs + ev.focusedMs,
          }
        : { ...current, focusMs: current.focusMs + ev.focusedMs };
    case 'attempt':
      return {
        ...current,
        attempts: {
          ...current.attempts,
          [ev.host]: (current.attempts[ev.host] ?? 0) + 1,
        },
      };
    case 'gateResisted':
      return { ...current, resisted: current.resisted + 1 };
    case 'budgetEarned':
      return { ...current, pauseMsEarned: (current.pauseMsEarned ?? 0) + ev.ms };
    case 'pauseTaken':
      return {
        ...current,
        pausesTaken: current.pausesTaken + 1,
        pauseMsSpent: current.pauseMsSpent + ev.ms,
      };
    case 'unlockTaken':
      return {
        ...current,
        unlocksTaken: current.unlocksTaken + 1,
        unlockMsSpent: (current.unlockMsSpent ?? 0) + ev.ms,
      };
    default:
      return current;
  }
}

/** Additive merge of the same calendar day recorded on different devices. */
export function mergeDaily(sameDay: DailyAgg[]): DailyAgg {
  let out: DailyAgg = emptyDaily(sameDay[0]?.date ?? '');
  for (const d of sameDay) out = sumCounters(out, d);
  return out;
}

export function mergeMonthly(sameMonth: MonthlyAgg[]): MonthlyAgg {
  let out: MonthlyAgg = emptyMonthly(sameMonth[0]?.month ?? '');
  for (const m of sameMonth) out = sumCounters(out, m);
  return out;
}

/** Keeps the topN attempt hosts, folds the rest into attemptsOther. */
export function capAttempts(agg: DailyAgg, topN: number): DailyAgg {
  return capCounters(agg, topN);
}

export function rollupMonth(month: string, dailies: DailyAgg[]): MonthlyAgg {
  let out: MonthlyAgg = emptyMonthly(month);
  for (const d of dailies) out = sumCounters(out, d);
  return capCounters(out, TOP_SITES_MONTHLY);
}
