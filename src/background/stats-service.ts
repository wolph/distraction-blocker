import { mergeDaily, mergeMonthly, rollupMonth } from '../core/stats';
import { emptyStreak } from '../core/streak';
import type { StatsBundle } from '../shared/messages';
import { SYNC_STREAK, syncMonthKey } from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type { DailyAgg, EventRecord, MonthlyAgg, StreakState } from '../shared/types';
import { getDeviceId, readEvents } from './stores';

const DAY_MS: number = 86_400_000;
const DAILY_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;
const RECENT_SESSION_CAP: number = 50;

interface PrunePlan {
  remove: string[];
  set: Record<string, unknown>;
}

function groupPush<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list: T[] = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

function sumAttempts(agg: DailyAgg): number {
  return (
    Object.values(agg.attempts).reduce((a: number, b: number): number => a + b, 0) +
    agg.attemptsOther
  );
}

/**
 * Pure read-side merge: groups agg items by date and month, merges the
 * same calendar day across devices additively, computes the tiles.
 */
export function buildStats(
  _deviceId: string,
  syncItems: Record<string, unknown>,
  events: EventRecord[],
  days: number,
  now: number,
): StatsBundle {
  const dailyByDate: Map<string, DailyAgg[]> = new Map();
  const monthlyByMonth: Map<string, MonthlyAgg[]> = new Map();
  const entries: Array<[string, unknown]> = Object.entries(syncItems);
  for (let index: number = 0; index < entries.length; index++) {
    const entry: [string, unknown] = entries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    const dailyDate: string | undefined = DAILY_KEY_RE.exec(key)?.[1];
    if (dailyDate !== undefined) {
      groupPush(dailyByDate, dailyDate, value as DailyAgg);
      continue;
    }
    const month: string | undefined = MONTHLY_KEY_RE.exec(key)?.[1];
    if (month !== undefined) groupPush(monthlyByMonth, month, value as MonthlyAgg);
  }
  const fromDate: string = localDateStr(now - (days - 1) * DAY_MS);
  const daysMerged: DailyAgg[] = [...dailyByDate.entries()]
    .filter(([date]: [string, DailyAgg[]]): boolean => date >= fromDate)
    .sort(([a]: [string, DailyAgg[]], [b]: [string, DailyAgg[]]): number => a.localeCompare(b))
    .map(([, aggs]: [string, DailyAgg[]]): DailyAgg => mergeDaily(aggs));
  const months: MonthlyAgg[] = [...monthlyByMonth.entries()]
    .sort(([a]: [string, MonthlyAgg[]], [b]: [string, MonthlyAgg[]]): number => a.localeCompare(b))
    .map(([, aggs]: [string, MonthlyAgg[]]): MonthlyAgg => mergeMonthly(aggs));
  const streak: StreakState =
    (syncItems[SYNC_STREAK] as StreakState | undefined) ?? emptyStreak(localMonthStr(now));
  const recentSessions: EventRecord[] = events
    .filter(
      (e: EventRecord): boolean =>
        e.t === 'sessionStarted' || e.t === 'sessionCompleted' || e.t === 'sessionCanceled',
    )
    .slice(-RECENT_SESSION_CAP)
    .reverse();
  const today: string = localDateStr(now);
  const weekFrom: string = localDateStr(now - 6 * DAY_MS);
  const todayAgg: DailyAgg | undefined = daysMerged.find(
    (d: DailyAgg): boolean => d.date === today,
  );
  return {
    days: daysMerged,
    months,
    streak,
    recentSessions,
    totals: {
      focusMsToday: todayAgg?.focusMs ?? 0,
      focusMsWeek: daysMerged
        .filter((d: DailyAgg): boolean => d.date >= weekFrom)
        .reduce((a: number, d: DailyAgg): number => a + d.focusMs, 0),
      attemptsToday: todayAgg === undefined ? 0 : sumAttempts(todayAgg),
      resistedToday: todayAgg?.resisted ?? 0,
    },
  };
}

/**
 * Pure retention plan for THIS device's keys only: dailies older than
 * retention roll into the device's monthly item, their keys are listed
 * for chrome.storage.sync.remove. Other devices prune their own.
 */
export function pruneAndRollup(
  deviceId: string,
  syncItems: Record<string, unknown>,
  retentionDays: number,
  now: number,
): PrunePlan {
  const cutoff: string = localDateStr(now - retentionDays * DAY_MS);
  const mineRe: RegExp = new RegExp(`^agg:${deviceId}:(\\d{4}-\\d{2}-\\d{2})$`);
  const remove: string[] = [];
  const byMonth: Map<string, DailyAgg[]> = new Map();
  const entries: Array<[string, unknown]> = Object.entries(syncItems);
  for (let index: number = 0; index < entries.length; index++) {
    const entry: [string, unknown] = entries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    const date: string | undefined = mineRe.exec(key)?.[1];
    if (date === undefined || date >= cutoff) continue;
    remove.push(key);
    groupPush(byMonth, date.slice(0, 7), value as DailyAgg);
  }
  const set: Record<string, unknown> = {};
  const months: Array<[string, DailyAgg[]]> = [...byMonth.entries()];
  for (let index: number = 0; index < months.length; index++) {
    const entry: [string, DailyAgg[]] = months[index] as [string, DailyAgg[]];
    const month: string = entry[0];
    const dailies: DailyAgg[] = entry[1];
    const monthKey: string = syncMonthKey(deviceId, month);
    const existing: MonthlyAgg | undefined = syncItems[monthKey] as MonthlyAgg | undefined;
    const rolled: MonthlyAgg = rollupMonth(month, dailies);
    set[monthKey] = existing === undefined ? rolled : mergeMonthly([existing, rolled]);
  }
  return { remove, set };
}

/** Reads sync storage and the local event log, answers the getStats message. */
export async function fetchStats(days: number, now: number): Promise<StatsBundle> {
  const loaded: [string, Record<string, unknown>, EventRecord[]] = await Promise.all([
    getDeviceId(),
    chrome.storage.sync.get(null) as Promise<Record<string, unknown>>,
    readEvents(),
  ]);
  const deviceId: string = loaded[0];
  const syncItems: Record<string, unknown> = loaded[1];
  const events: EventRecord[] = loaded[2];
  return buildStats(deviceId, syncItems, events, days, now);
}

/** Applies a prune plan to sync storage. Called weekly from the engine. */
export async function runPrune(retentionDays: number, now: number): Promise<void> {
  const loaded: [string, Record<string, unknown>] = await Promise.all([
    getDeviceId(),
    chrome.storage.sync.get(null) as Promise<Record<string, unknown>>,
  ]);
  const deviceId: string = loaded[0];
  const syncItems: Record<string, unknown> = loaded[1];
  const plan: PrunePlan = pruneAndRollup(deviceId, syncItems, retentionDays, now);
  if (Object.keys(plan.set).length > 0) await chrome.storage.sync.set(plan.set);
  if (plan.remove.length > 0) await chrome.storage.sync.remove(plan.remove);
}
