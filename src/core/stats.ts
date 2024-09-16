import type { DailyAgg, EventRecord, MonthlyAgg } from '../shared/types';

export function emptyDaily(date: string): DailyAgg {
  throw new Error('not implemented, plan 02');
}

/** Folds one event into the day it belongs to. Ignores event kinds that do not aggregate. */
export function addEvent(agg: DailyAgg, ev: EventRecord): DailyAgg {
  throw new Error('not implemented, plan 02');
}

/** Additive merge of the same calendar day recorded on different devices. */
export function mergeDaily(sameDay: DailyAgg[]): DailyAgg {
  throw new Error('not implemented, plan 02');
}

export function mergeMonthly(sameMonth: MonthlyAgg[]): MonthlyAgg {
  throw new Error('not implemented, plan 02');
}

/** Keeps the topN attempt hosts, folds the rest into attemptsOther. */
export function capAttempts(agg: DailyAgg, topN: number): DailyAgg {
  throw new Error('not implemented, plan 02');
}

export function rollupMonth(month: string, dailies: DailyAgg[]): MonthlyAgg {
  throw new Error('not implemented, plan 02');
}
