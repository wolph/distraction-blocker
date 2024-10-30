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
  unlocksTaken: number;
  resisted: number;
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
    unlocksTaken: into.unlocksTaken + from.unlocksTaken,
    resisted: into.resisted + from.resisted,
  };
}

/** Deterministic top-N: count desc, then host asc. The tail folds into attemptsOther. */
function capCounters<T extends AggCounters>(agg: T, topN: number): T {
  const entries: Array<[string, number]> = Object.entries(agg.attempts).sort(
    (a: [string, number], b: [string, number]): number => b[1] - a[1] || (a[0] < b[0] ? -1 : 1),
  );
  const kept: Record<string, number> = {};
  let folded: number = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry: [string, number] | undefined = entries[i];
    if (entry === undefined) continue;
    if (i < topN) kept[entry[0]] = entry[1];
    else folded += entry[1];
  }
  return { ...agg, attempts: kept, attemptsOther: agg.attemptsOther + folded };
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
    unlocksTaken: 0,
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
    unlocksTaken: 0,
    resisted: 0,
  };
}

/** Folds one event into the day it belongs to. Ignores event kinds that do not aggregate. */
export function addEvent(agg: DailyAgg, ev: EventRecord): DailyAgg {
  switch (ev.t) {
    case 'sessionStarted':
      return { ...agg, sessionsStarted: agg.sessionsStarted + 1 };
    case 'sessionCompleted':
      return {
        ...agg,
        sessionsCompleted: agg.sessionsCompleted + 1,
        focusMs: agg.focusMs + ev.focusedMs,
      };
    case 'sessionCanceled':
      // Canceled sessions still contribute the focus they achieved.
      return { ...agg, focusMs: agg.focusMs + ev.focusedMs };
    case 'attempt':
      return {
        ...agg,
        attempts: { ...agg.attempts, [ev.host]: (agg.attempts[ev.host] ?? 0) + 1 },
      };
    case 'gateResisted':
      return { ...agg, resisted: agg.resisted + 1 };
    case 'pauseTaken':
      return { ...agg, pausesTaken: agg.pausesTaken + 1, pauseMsSpent: agg.pauseMsSpent + ev.ms };
    case 'unlockTaken':
      return { ...agg, unlocksTaken: agg.unlocksTaken + 1 };
    default:
      return agg;
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
