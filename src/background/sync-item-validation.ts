import { isDailyDate, parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { isListsConfig, isSettings } from '../shared/runtime-validation';
import { SYNC_BANK, SYNC_LISTS, SYNC_SETTINGS, SYNC_STREAK } from '../shared/storage-keys';
import { isListSyncKey, isListsCategoryShardValue, isSplitListsBaseValue } from './list-sync-codec';
import { parseBank, parseStreak } from './stores';

const DAILY_KEY_RE: RegExp = /^agg:([^:]+):(\d{4}-\d{2}-\d{2})$/;
const MONTHLY_KEY_RE: RegExp = /^aggm:([^:]+):(\d{4}-\d{2})$/;
const PRUNE_KEY_RE: RegExp = /^prune:([^:]+)$/;
const CLOCK_REBASE_ARCHIVE_KEY_RE: RegExp =
  /^archive:clock-rebase:([^:]+):(\d{4}-\d{2}-\d{2}):(\d+):([^:]+)$/;
const AGGREGATE_COUNTER_KEYS: readonly string[] = [
  'focusMs',
  'sessionsStarted',
  'sessionsCompleted',
  'attempts',
  'attemptsOther',
  'pausesTaken',
  'pauseMsSpent',
  'pauseMsEarned',
  'unlocksTaken',
  'unlockMsSpent',
  'resisted',
];

function isDensePlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key: string | symbol): boolean => {
    if (typeof key !== 'string') return false;
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual: string[] = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    expected.every((key: string): boolean => actual.includes(key))
  );
}

function hasAggregateKeys(value: unknown, periodKey: 'date' | 'month'): boolean {
  if (!isDensePlainRecord(value)) return false;
  const required: string[] = [
    periodKey,
    ...AGGREGATE_COUNTER_KEYS.filter(
      (key: string): boolean => key !== 'pauseMsEarned' && key !== 'unlockMsSpent',
    ),
  ];
  const allowed: Set<string> = new Set([periodKey, ...AGGREGATE_COUNTER_KEYS]);
  return (
    required.every((key: string): boolean => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key: string): boolean => allowed.has(key))
  );
}

function isPruneCheckpoint(key: string, value: unknown): boolean {
  const deviceId: string | undefined = PRUNE_KEY_RE.exec(key)?.[1];
  if (deviceId === undefined || !isDensePlainRecord(value) || !hasExactKeys(value, ['remove'])) {
    return false;
  }
  const remove: unknown = value.remove;
  if (!Array.isArray(remove) || Object.keys(remove).length !== remove.length) return false;
  const seen: Set<string> = new Set();
  return remove.every((candidate: unknown): boolean => {
    if (typeof candidate !== 'string' || seen.has(candidate)) return false;
    seen.add(candidate);
    const match: RegExpExecArray | null = DAILY_KEY_RE.exec(candidate);
    return match?.[1] === deviceId && isDailyDate(match[2]);
  });
}

export function isSupportedSyncItemKey(key: string): boolean {
  return (
    key === SYNC_SETTINGS ||
    isListSyncKey(key) ||
    key === SYNC_BANK ||
    key === SYNC_STREAK ||
    DAILY_KEY_RE.test(key) ||
    MONTHLY_KEY_RE.test(key) ||
    PRUNE_KEY_RE.test(key) ||
    CLOCK_REBASE_ARCHIVE_KEY_RE.test(key)
  );
}

export function isFocusLockSyncKey(key: string): boolean {
  return isSupportedSyncItemKey(key) || CLOCK_REBASE_ARCHIVE_KEY_RE.test(key);
}

export function isFocusLockDeletionKey(key: string): boolean {
  return (
    key === SYNC_SETTINGS ||
    key === SYNC_LISTS ||
    key === SYNC_BANK ||
    key === SYNC_STREAK ||
    key.startsWith('lists:category:') ||
    key.startsWith('agg:') ||
    key.startsWith('aggm:') ||
    key.startsWith('prune:') ||
    key.startsWith('archive:clock-rebase:')
  );
}

export function isAuthoritativeSyncItem(key: string, value: unknown): boolean {
  if (key === SYNC_SETTINGS) return isSettings(value);
  if (key === SYNC_LISTS) return isListsConfig(value) || isSplitListsBaseValue(value);
  if (isListSyncKey(key)) return isListsCategoryShardValue(key, value);
  if (key === SYNC_BANK) {
    return (
      isDensePlainRecord(value) && hasExactKeys(value, ['balanceMs']) && parseBank(value) !== null
    );
  }
  if (key === SYNC_STREAK) {
    return (
      isDensePlainRecord(value) &&
      hasExactKeys(value, [
        'current',
        'freezeTokens',
        'lastCountedDate',
        'lastFreezeGrantDate',
        'activeDays',
        'activeMonth',
      ]) &&
      parseStreak(value) !== null
    );
  }
  const dailyMatch: RegExpExecArray | null = DAILY_KEY_RE.exec(key);
  if (dailyMatch !== null) {
    return hasAggregateKeys(value, 'date') && parseDailyAgg(value, dailyMatch[2]) !== null;
  }
  const monthlyMatch: RegExpExecArray | null = MONTHLY_KEY_RE.exec(key);
  if (monthlyMatch !== null) {
    return hasAggregateKeys(value, 'month') && parseMonthlyAgg(value, monthlyMatch[2]) !== null;
  }
  const archiveMatch: RegExpExecArray | null = CLOCK_REBASE_ARCHIVE_KEY_RE.exec(key);
  if (archiveMatch !== null) {
    return hasAggregateKeys(value, 'date') && parseDailyAgg(value, archiveMatch[2]) !== null;
  }
  return isPruneCheckpoint(key, value);
}
