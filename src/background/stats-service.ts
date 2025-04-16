import {
  mergeDaily,
  mergeMonthly,
  parseDailyAgg,
  parseMonthlyAgg,
  rollupMonth,
} from '../core/stats';
import { emptyStreak } from '../core/streak';
import type { StatsBundle } from '../shared/messages';
import { isSafeDayCount } from '../shared/numeric-validation';
import {
  LOCAL_AGGREGATE_PRUNE,
  LOCAL_AGGREGATE_TOMBSTONES,
  SYNC_STREAK,
  syncAggKey,
  syncMonthKey,
} from '../shared/storage-keys';
import { localDateStr, localMonthStr } from '../shared/time';
import type { DailyAgg, EventRecord, MonthlyAgg, StreakState } from '../shared/types';
import { getDeviceId, parseStreak, readEvents } from './stores';
import { chooseNewerStreak } from './streak-sync';
import { removeSyncItems, setSyncItemsWithinQuota } from './sync-quota';

const DAILY_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;
const RECENT_SESSION_ROW_CAP: number = 50;
const MAX_CLOCK_REBASE_ARCHIVES: number = 20;

type RecentSessionEvent = Extract<
  EventRecord,
  {
    t:
      | 'sessionStarted'
      | 'sessionCompleted'
      | 'sessionCanceled'
      | 'sessionIdentityAssigned'
      | 'pauseTaken'
      | 'unlockTaken';
  }
>;

interface SessionEventGroup {
  sessionId?: string;
  events: RecentSessionEvent[];
}

interface PrunePlan {
  remove: string[];
  set: Record<string, unknown>;
}

interface PruneCheckpoint {
  remove: string[];
}

export interface AggregateStorage {
  local: chrome.storage.StorageArea;
  sync: chrome.storage.SyncStorageArea | null;
}

export interface LocalAggregatePruneCheckpoint {
  set: Record<string, unknown>;
  remove: string[];
}

export interface StatsOverlay {
  deviceId: string;
  todayAgg: DailyAgg;
  streak: StreakState | null;
  pendingEvents: EventRecord[];
}

function isAggregateStatsKey(key: string): boolean {
  return DAILY_KEY_RE.test(key) || MONTHLY_KEY_RE.test(key);
}

function isOwnedAggregateStatsKey(key: string, deviceId: string): boolean {
  return key.startsWith(`agg:${deviceId}:`) || key.startsWith(`aggm:${deviceId}:`);
}

function parseAggregateTombstones(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.filter(
      (key: unknown): key is string => typeof key === 'string' && isAggregateStatsKey(key),
    ),
  );
}

function parseLocalPruneCheckpoint(value: unknown): LocalAggregatePruneCheckpoint | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as { set?: unknown; remove?: unknown };
  if (
    typeof candidate.set !== 'object' ||
    candidate.set === null ||
    Array.isArray(candidate.set) ||
    !Array.isArray(candidate.remove)
  ) {
    return null;
  }
  const set: Record<string, unknown> = candidate.set as Record<string, unknown>;
  if (!Object.keys(set).every(isAggregateStatsKey)) return null;
  if (
    !candidate.remove.every(
      (key: unknown): key is string => typeof key === 'string' && isAggregateStatsKey(key),
    )
  ) {
    return null;
  }
  return { set: structuredClone(set), remove: [...candidate.remove] };
}

export function projectedLocalAggregateItems(
  items: Record<string, unknown>,
): Record<string, unknown> {
  const projected: Record<string, unknown> = Object.fromEntries(
    Object.entries(items).filter(([key]: [string, unknown]): boolean => isAggregateStatsKey(key)),
  );
  const checkpoint: LocalAggregatePruneCheckpoint | null = parseLocalPruneCheckpoint(
    items[LOCAL_AGGREGATE_PRUNE],
  );
  if (checkpoint !== null) {
    for (const key of checkpoint.remove) delete projected[key];
    Object.assign(projected, checkpoint.set);
  }
  for (const key of parseAggregateTombstones(items[LOCAL_AGGREGATE_TOMBSTONES])) {
    delete projected[key];
  }
  return projected;
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

function localDateBefore(now: number, daysBefore: number): string {
  const date: Date = new Date(now);
  date.setDate(date.getDate() - daysBefore);
  return localDateStr(date.getTime());
}

function isRecentSessionEvent(event: EventRecord): event is RecentSessionEvent {
  return (
    event.t === 'sessionStarted' ||
    event.t === 'sessionCompleted' ||
    event.t === 'sessionCanceled' ||
    event.t === 'sessionIdentityAssigned' ||
    event.t === 'pauseTaken' ||
    event.t === 'unlockTaken'
  );
}

function latestIdentifiedOpen(
  identifiedOpens: Map<string, SessionEventGroup>,
  identifiedOpenOrder: SessionEventGroup[],
): SessionEventGroup | undefined {
  let latest: SessionEventGroup | undefined = identifiedOpenOrder.at(-1);
  while (
    latest !== undefined &&
    (latest.sessionId === undefined || identifiedOpens.get(latest.sessionId) !== latest)
  ) {
    identifiedOpenOrder.pop();
    latest = identifiedOpenOrder.at(-1);
  }
  return latest;
}

function recentSessionEvents(events: EventRecord[]): EventRecord[] {
  const groups: SessionEventGroup[] = [];
  const identifiedOpens: Map<string, SessionEventGroup> = new Map();
  const identifiedOpenOrder: SessionEventGroup[] = [];
  let legacyOpen: SessionEventGroup | null = null;
  for (const event of events) {
    if (!isRecentSessionEvent(event)) continue;
    const sessionId: string | undefined = event.sessionId;
    if (event.t === 'sessionIdentityAssigned') {
      const started: RecentSessionEvent | undefined = legacyOpen?.events[0];
      if (
        legacyOpen === null ||
        started?.t !== 'sessionStarted' ||
        started.at !== event.startedAt ||
        identifiedOpens.has(event.sessionId)
      ) {
        continue;
      }
      legacyOpen.sessionId = event.sessionId;
      legacyOpen.events.push(event);
      identifiedOpens.set(event.sessionId, legacyOpen);
      identifiedOpenOrder.push(legacyOpen);
      legacyOpen = null;
      continue;
    }
    if (event.t === 'sessionStarted') {
      const group: SessionEventGroup = {
        ...(sessionId === undefined ? {} : { sessionId }),
        events: [event],
      };
      groups.push(group);
      if (sessionId === undefined) {
        legacyOpen = group;
      } else {
        identifiedOpens.set(sessionId, group);
        identifiedOpenOrder.push(group);
      }
      continue;
    }
    const group: SessionEventGroup | undefined =
      sessionId === undefined
        ? (legacyOpen ??
          (event.t === 'pauseTaken' || event.t === 'unlockTaken'
            ? latestIdentifiedOpen(identifiedOpens, identifiedOpenOrder)
            : undefined))
        : identifiedOpens.get(sessionId);
    if (group === undefined) continue;
    group.events.push(event);
    if (event.t === 'sessionCompleted' || event.t === 'sessionCanceled') {
      if (sessionId === undefined && legacyOpen !== null) {
        legacyOpen = null;
      } else if (group.sessionId !== undefined) {
        identifiedOpens.delete(group.sessionId);
      }
    }
  }
  const retained: Set<RecentSessionEvent> = new Set(
    groups
      .slice(-RECENT_SESSION_ROW_CAP)
      .flatMap((group: SessionEventGroup): RecentSessionEvent[] => group.events),
  );
  return events
    .filter(isRecentSessionEvent)
    .filter((event: RecentSessionEvent): boolean => {
      return retained.has(event);
    })
    .reverse();
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
  live: StatsOverlay | null = null,
): StatsBundle {
  const items: Record<string, unknown> = { ...syncItems };
  const allEvents: EventRecord[] = mergeEvents(events, live?.pendingEvents ?? []);
  const today: string = localDateStr(now);
  if (live !== null) {
    items[syncAggKey(live.deviceId, live.todayAgg.date)] = live.todayAgg;
    const syncedStreak: StreakState | null = parseStreak(items[SYNC_STREAK]);
    const currentStreak: StreakState | null = chooseNewerStreak(syncedStreak, live.streak);
    if (currentStreak !== null) items[SYNC_STREAK] = currentStreak;
  }
  const dailyByDate: Map<string, DailyAgg[]> = new Map();
  const monthlyByMonth: Map<string, MonthlyAgg[]> = new Map();
  const entries: Array<[string, unknown]> = Object.entries(items);
  for (let index: number = 0; index < entries.length; index++) {
    const entry: [string, unknown] = entries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    const dailyDate: string | undefined = DAILY_KEY_RE.exec(key)?.[1];
    if (dailyDate !== undefined && dailyDate <= today) {
      const daily: DailyAgg | null = parseDailyAgg(value, dailyDate);
      if (daily !== null) groupPush(dailyByDate, dailyDate, daily);
      continue;
    }
    const month: string | undefined = MONTHLY_KEY_RE.exec(key)?.[1];
    if (month !== undefined) {
      const monthly: MonthlyAgg | null = parseMonthlyAgg(value, month);
      if (monthly !== null) groupPush(monthlyByMonth, month, monthly);
    }
  }
  const fromDate: string = localDateBefore(now, days - 1);
  const daysMerged: DailyAgg[] = [...dailyByDate.entries()]
    .filter(([date]: [string, DailyAgg[]]): boolean => date >= fromDate)
    .sort(([a]: [string, DailyAgg[]], [b]: [string, DailyAgg[]]): number => a.localeCompare(b))
    .map(([, aggs]: [string, DailyAgg[]]): DailyAgg => mergeDaily(aggs));
  const months: MonthlyAgg[] = [...monthlyByMonth.entries()]
    .sort(([a]: [string, MonthlyAgg[]], [b]: [string, MonthlyAgg[]]): number => a.localeCompare(b))
    .map(([, aggs]: [string, MonthlyAgg[]]): MonthlyAgg => mergeMonthly(aggs));
  const streak: StreakState = parseStreak(items[SYNC_STREAK]) ?? emptyStreak(localMonthStr(now));
  const recentSessions: EventRecord[] = recentSessionEvents(allEvents);
  const weekFrom: string = localDateBefore(now, 6);
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
  if (!isSafeDayCount(retentionDays)) {
    throw new RangeError('retentionDays must be within the supported day range.');
  }
  const cutoff: string = localDateBefore(now, retentionDays - 1);
  const mineRe: RegExp = new RegExp(`^agg:${deviceId}:(\\d{4}-\\d{2}-\\d{2})$`);
  const archiveRe: RegExp = new RegExp(
    `^archive:clock-rebase:${deviceId}:\\d{4}-\\d{2}-\\d{2}:(\\d+):[^:]+$`,
  );
  const remove: string[] = [];
  const archives: Array<{ key: string; at: number }> = [];
  const byMonth: Map<string, DailyAgg[]> = new Map();
  const entries: Array<[string, unknown]> = Object.entries(syncItems);
  for (let index: number = 0; index < entries.length; index++) {
    const entry: [string, unknown] = entries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    const archiveAt: string | undefined = archiveRe.exec(key)?.[1];
    if (archiveAt !== undefined) {
      archives.push({ key, at: Number(archiveAt) });
      continue;
    }
    const date: string | undefined = mineRe.exec(key)?.[1];
    if (date === undefined || date >= cutoff) continue;
    remove.push(key);
    const daily: DailyAgg | null = parseDailyAgg(value, date);
    if (daily !== null) groupPush(byMonth, date.slice(0, 7), daily);
  }
  archives.sort(
    (left: { key: string; at: number }, right: { key: string; at: number }): number =>
      right.at - left.at || right.key.localeCompare(left.key),
  );
  remove.push(
    ...archives
      .slice(MAX_CLOCK_REBASE_ARCHIVES)
      .map((archive: { key: string; at: number }): string => archive.key),
  );
  const set: Record<string, unknown> = {};
  const months: Array<[string, DailyAgg[]]> = [...byMonth.entries()];
  for (let index: number = 0; index < months.length; index++) {
    const entry: [string, DailyAgg[]] = months[index] as [string, DailyAgg[]];
    const month: string = entry[0];
    const dailies: DailyAgg[] = entry[1];
    const monthKey: string = syncMonthKey(deviceId, month);
    const existing: MonthlyAgg | null = parseMonthlyAgg(syncItems[monthKey], month);
    const rolled: MonthlyAgg = rollupMonth(month, dailies);
    set[monthKey] = existing === null ? rolled : mergeMonthly([existing, rolled]);
  }
  return { remove, set };
}

/** Reads sync storage and the local event log, answers the getStats message. */
export async function fetchStats(
  days: number,
  now: number,
  live: StatsOverlay | null = null,
  storage: AggregateStorage = { local: chrome.storage.local, sync: chrome.storage.sync },
): Promise<StatsBundle> {
  const loaded: [string, Record<string, unknown>, Record<string, unknown>, EventRecord[]] =
    await Promise.all([
      getDeviceId(),
      storage.local.get(null) as Promise<Record<string, unknown>>,
      storage.sync === null
        ? Promise.resolve({})
        : (storage.sync.get(null) as Promise<Record<string, unknown>>),
      readEvents(),
    ]);
  const deviceId: string = loaded[0];
  const localItems: Record<string, unknown> = projectedLocalAggregateItems(loaded[1]);
  const remoteItems: Record<string, unknown> = loaded[2];
  const events: EventRecord[] = loaded[3];
  const aggregateItems: Record<string, unknown> =
    storage.sync === null
      ? localItems
      : {
          ...remoteItems,
          ...Object.fromEntries(
            Object.entries(localItems).filter(([key]: [string, unknown]): boolean =>
              isOwnedAggregateStatsKey(key, deviceId),
            ),
          ),
        };
  if (storage.sync !== null) {
    for (const key of parseAggregateTombstones(loaded[1][LOCAL_AGGREGATE_TOMBSTONES])) {
      delete aggregateItems[key];
    }
  }
  return buildStats(deviceId, aggregateItems, events, days, now, live);
}

function mergeEvents(stored: EventRecord[], pending: EventRecord[]): EventRecord[] {
  const seen: Set<string> = new Set(
    stored.map((event: EventRecord): string => JSON.stringify(event)),
  );
  const merged: EventRecord[] = [...stored];
  for (const event of pending) {
    const key: string = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(event);
  }
  return merged;
}

/** Applies a prune plan to sync storage. Called weekly from the engine. */
export async function runPrune(
  retentionDays: number,
  now: number,
  storage: AggregateStorage = { local: chrome.storage.local, sync: chrome.storage.sync },
): Promise<void> {
  const loaded: [string, Record<string, unknown>] = await Promise.all([
    getDeviceId(),
    storage.local.get(null) as Promise<Record<string, unknown>>,
  ]);
  const deviceId: string = loaded[0];
  const localItems: Record<string, unknown> = projectedLocalAggregateItems(loaded[1]);
  const plan: PrunePlan = pruneAndRollup(deviceId, localItems, retentionDays, now);
  await storage.local.set({
    [LOCAL_AGGREGATE_PRUNE]: { set: plan.set, remove: plan.remove },
    ...plan.set,
  });
  if (plan.remove.length > 0) await storage.local.remove(plan.remove);
  await storage.local.remove(LOCAL_AGGREGATE_PRUNE);
  if (storage.sync !== null) await applyPrunePlan(deviceId, plan, storage.sync, storage.local);
}

export async function applyPrunePlan(
  deviceId: string,
  plan: PrunePlan,
  sync: chrome.storage.SyncStorageArea = chrome.storage.sync,
  local: chrome.storage.StorageArea = chrome.storage.local,
): Promise<void> {
  const checkpointKey: string = `prune:${deviceId}`;
  const stored: unknown = (await sync.get(checkpointKey))[checkpointKey];
  const checkpoint: PruneCheckpoint | null = pruneCheckpoint(stored);
  if (checkpoint !== null) {
    if (checkpoint.remove.length > 0) await removeSyncItems(checkpoint.remove, sync, local);
    await removeSyncItems([checkpointKey], sync, local);
    return;
  }
  if (plan.remove.length === 0) {
    if (Object.keys(plan.set).length > 0) await setSyncItemsWithinQuota(plan.set, sync, local);
    return;
  }
  await setSyncItemsWithinQuota(
    {
      ...plan.set,
      [checkpointKey]: { remove: plan.remove } satisfies PruneCheckpoint,
    },
    sync,
    local,
  );
  await removeSyncItems(plan.remove, sync, local);
  await removeSyncItems([checkpointKey], sync, local);
}

function pruneCheckpoint(value: unknown): PruneCheckpoint | null {
  if (typeof value !== 'object' || value === null || !('remove' in value)) return null;
  const remove: unknown = (value as { remove: unknown }).remove;
  if (
    !Array.isArray(remove) ||
    !remove.every((key: unknown): key is string => typeof key === 'string')
  ) {
    return null;
  }
  return { remove };
}
