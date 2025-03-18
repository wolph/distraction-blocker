import { validateRule } from '../core/matcher';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import { isDailyDate, parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { CATEGORY_IDS, MAX_FREEZE_TOKENS } from './constants';
import type { Ack, StatsBundle } from './messages';
import {
  isPositiveMinuteValue,
  isRelativeMillisecondDuration,
  isRelativeMinuteDuration,
  isSafeDayCount,
} from './numeric-validation';
import type {
  CategoryId,
  CycleConfig,
  EventRecord,
  GateState,
  ListsConfig,
  PauseEconomy,
  Rule,
  ScheduleEntry,
  SessionConfig,
  SessionSnapshot,
  Settings,
  SiteUnlock,
  StreakState,
} from './types';

type UnknownRecord = Record<string, unknown>;

const MONTH_RE: RegExp = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is UnknownRecord {
  try {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

function isDenseArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value)) return false;
    for (let index: number = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function hasExactKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  try {
    const actual: PropertyKey[] = Reflect.ownKeys(value);
    return (
      actual.length === keys.length &&
      actual.every((key: PropertyKey): boolean => typeof key === 'string' && keys.includes(key))
    );
  } catch {
    return false;
  }
}

function safelyValidate(validate: () => boolean): boolean {
  try {
    return validate();
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isRule(value: unknown): value is Rule {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'pattern']) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return false;
  }
  return validateRule({ kind: value.kind, pattern: value.pattern }) === null;
}

function isCycleConfigValue(value: unknown): value is CycleConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['focusMin', 'shortBreakMin', 'longBreakMin', 'longEvery']) &&
    isRelativeMinuteDuration(value.focusMin) &&
    isRelativeMinuteDuration(value.shortBreakMin) &&
    isRelativeMinuteDuration(value.longBreakMin) &&
    isPositiveInteger(value.longEvery)
  );
}

export function isCycleConfig(value: unknown): value is CycleConfig {
  return safelyValidate((): boolean => isCycleConfigValue(value));
}

function isScheduleEntry(value: unknown): value is ScheduleEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'id',
      'days',
      'start',
      'end',
      'mode',
      'strictness',
      'cycling',
      'intention',
      'enabled',
    ]) ||
    !isNonBlankString(value.id) ||
    !isDenseArray(value.days) ||
    value.days.length === 0 ||
    !value.days.every((day: unknown): day is number => isNonNegativeInteger(day) && day <= 6) ||
    new Set(value.days).size !== value.days.length ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'hard' && value.strictness !== 'friction') ||
    (value.cycling !== null && !isCycleConfig(value.cycling)) ||
    typeof value.intention !== 'string' ||
    typeof value.enabled !== 'boolean'
  ) {
    return false;
  }
  const entry: ScheduleEntry = {
    id: value.id,
    days: value.days,
    start: value.start,
    end: value.end,
    mode: value.mode,
    strictness: value.strictness,
    cycling: value.cycling,
    intention: value.intention,
    enabled: value.enabled,
  };
  return validateEntry(entry) === null;
}

function isSchedule(value: unknown): value is ScheduleEntry[] {
  if (!isDenseArray(value)) return false;
  const ids: Set<string> = new Set<string>();
  for (let index: number = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
    const candidate: unknown = value[index];
    if (!isScheduleEntry(candidate)) return false;
    const entry: ScheduleEntry = candidate;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    for (let previousIndex: number = 0; previousIndex < index; previousIndex++) {
      const previous: ScheduleEntry = value[previousIndex] as ScheduleEntry;
      if (scheduleEntriesOverlap(previous, entry)) return false;
    }
  }
  return true;
}

function isPauseEconomyValue(value: unknown): value is PauseEconomy {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['earnRatio', 'capMs', 'pauseMs', 'unlockMs']) &&
    isNonNegativeNumber(value.earnRatio) &&
    isNonNegativeInteger(value.capMs) &&
    isRelativeMillisecondDuration(value.pauseMs, true) &&
    isRelativeMillisecondDuration(value.unlockMs, true)
  );
}

export function isPauseEconomy(value: unknown): value is PauseEconomy {
  return safelyValidate((): boolean => isPauseEconomyValue(value));
}

function isGateSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['delayMs', 'requireTypedPhrase']) &&
    isRelativeMillisecondDuration(value.delayMs, true) &&
    typeof value.requireTypedPhrase === 'boolean'
  );
}

function isThemeMode(value: unknown): boolean {
  return value === 'auto' || value === 'light' || value === 'dark';
}

function isSoundSettings(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'masterVolume',
      'sessionComplete',
      'breakStart',
      'breakEnd',
      'scheduleStart',
    ])
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.masterVolume) &&
    value.masterVolume <= 1 &&
    typeof value.sessionComplete === 'boolean' &&
    typeof value.breakStart === 'boolean' &&
    typeof value.breakEnd === 'boolean' &&
    typeof value.scheduleStart === 'boolean'
  );
}

function isSettingsValue(value: unknown): value is Settings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'theme',
      'presetsMin',
      'defaultMode',
      'defaultStrictness',
      'defaultCycling',
      'cyclingOnByDefault',
      'pause',
      'gate',
      'badgeCountdown',
      'sessionCompleteNotification',
      'sounds',
      'schedule',
      'streakGoalMin',
      'streakFreezeIntervalDays',
      'retentionDays',
    ])
  ) {
    return false;
  }
  return (
    isThemeMode(value.theme) &&
    isDenseArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isRelativeMinuteDuration) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' || value.defaultStrictness === 'friction') &&
    isCycleConfig(value.defaultCycling) &&
    typeof value.cyclingOnByDefault === 'boolean' &&
    isPauseEconomy(value.pause) &&
    isGateSettings(value.gate) &&
    typeof value.badgeCountdown === 'boolean' &&
    typeof value.sessionCompleteNotification === 'boolean' &&
    isSoundSettings(value.sounds) &&
    isSchedule(value.schedule) &&
    isPositiveMinuteValue(value.streakGoalMin) &&
    isSafeDayCount(value.streakFreezeIntervalDays) &&
    isSafeDayCount(value.retentionDays)
  );
}

export function isSettings(value: unknown): value is Settings {
  return safelyValidate((): boolean => isSettingsValue(value));
}

function isValidRuleHost(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.trim() === value &&
    validateRule({ kind: 'host', pattern: value }) === null
  );
}

function isCategories(value: unknown): value is ListsConfig['categories'] {
  return (
    isRecord(value) &&
    hasExactKeys(value, CATEGORY_IDS) &&
    CATEGORY_IDS.every((id: CategoryId): boolean => typeof value[id] === 'boolean')
  );
}

function isExclusions(value: unknown): value is ListsConfig['exclusions'] {
  if (!isRecord(value)) return false;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (
    !keys.every(
      (key: PropertyKey): boolean =>
        typeof key === 'string' && CATEGORY_IDS.includes(key as CategoryId),
    )
  ) {
    return false;
  }
  return keys.every((key: PropertyKey): boolean => {
    const hosts: unknown = value[key as string];
    return isDenseArray(hosts) && hosts.every(isValidRuleHost);
  });
}

function isListsConfigValue(value: unknown): value is ListsConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['custom', 'whitelist', 'categories', 'exclusions']) &&
    isDenseArray(value.custom) &&
    value.custom.every(isRule) &&
    isDenseArray(value.whitelist) &&
    value.whitelist.every(isRule) &&
    isCategories(value.categories) &&
    isExclusions(value.exclusions)
  );
}

export function isListsConfig(value: unknown): value is ListsConfig {
  return safelyValidate((): boolean => isListsConfigValue(value));
}

function isSessionConfig(value: unknown): value is SessionConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mode',
      'strictness',
      'durationMin',
      'cycling',
      'intention',
      'source',
      'scheduleEntryId',
    ])
  ) {
    return false;
  }
  if (
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'hard' && value.strictness !== 'friction') ||
    !isRelativeMinuteDuration(value.durationMin) ||
    (value.cycling !== null && !isCycleConfig(value.cycling)) ||
    typeof value.intention !== 'string' ||
    (value.source !== 'manual' && value.source !== 'schedule') ||
    !isNullableString(value.scheduleEntryId)
  ) {
    return false;
  }
  return (
    (value.source === 'manual' && value.scheduleEntryId === null) ||
    (value.source === 'schedule' && isNonBlankString(value.scheduleEntryId))
  );
}

function isGate(value: unknown): value is GateState {
  if (!isRecord(value)) return false;
  if (
    (value.kind !== 'pause' && value.kind !== 'unlockSite' && value.kind !== 'cancel') ||
    !isNullableString(value.host) ||
    !isNonNegativeNumber(value.openedAt) ||
    !isNonNegativeNumber(value.readyAt) ||
    value.readyAt < value.openedAt ||
    !isNullableString(value.requiredPhrase)
  ) {
    return false;
  }
  return value.kind === 'unlockSite' ? isNonBlankString(value.host) : value.host === null;
}

function isSiteUnlock(value: unknown): value is SiteUnlock {
  return isRecord(value) && isNonBlankString(value.host) && isNonNegativeNumber(value.until);
}

function isNextSchedule(value: unknown): boolean {
  return isRecord(value) && isNonBlankString(value.entryId) && isNonNegativeNumber(value.startsAt);
}

function isSessionSnapshotValue(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false;
  const phaseValid: boolean =
    value.phase === 'idle' ||
    value.phase === 'focus' ||
    value.phase === 'break' ||
    value.phase === 'paused';
  if (
    !isNonNegativeNumber(value.at) ||
    !isThemeMode(value.theme) ||
    !phaseValid ||
    !isNonNegativeInteger(value.cycleIndex) ||
    !isNonNegativeNumber(value.bankMs) ||
    !isNonNegativeNumber(value.bankAccrualPerMs) ||
    !isNonNegativeInteger(value.bankCapMs) ||
    !isRelativeMillisecondDuration(value.pauseCostMs, true) ||
    !isRelativeMillisecondDuration(value.unlockCostMs, true) ||
    !isDenseArray(value.activeUnlocks) ||
    !value.activeUnlocks.every(isSiteUnlock) ||
    (value.gate !== null && !isGate(value.gate)) ||
    !isNonNegativeInteger(value.attemptsToday) ||
    typeof value.scheduleActive !== 'boolean' ||
    (value.nextSchedule !== null && !isNextSchedule(value.nextSchedule))
  ) {
    return false;
  }
  if (value.phase === 'idle') {
    return (
      value.config === null &&
      value.startedAt === null &&
      value.phaseStartedAt === null &&
      value.phaseEndsAt === null &&
      value.sessionEndsAt === null &&
      value.gate === null
    );
  }
  if (
    !isSessionConfig(value.config) ||
    !isNonNegativeNumber(value.startedAt) ||
    !isNonNegativeNumber(value.phaseStartedAt) ||
    !isNonNegativeNumber(value.phaseEndsAt) ||
    !isNonNegativeNumber(value.sessionEndsAt) ||
    value.sessionEndsAt < value.startedAt ||
    value.phaseStartedAt < value.startedAt ||
    value.phaseEndsAt < value.phaseStartedAt ||
    (value.phase !== 'paused' && value.phaseEndsAt > value.sessionEndsAt)
  ) {
    return false;
  }
  return value.phase !== 'break' || value.config.cycling !== null;
}

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  return safelyValidate((): boolean => isSessionSnapshotValue(value));
}

function isNullableDailyDate(value: unknown): value is string | null {
  return value === null || isDailyDate(value);
}

function isStreak(value: unknown): value is StreakState {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.current) ||
    !isNonNegativeInteger(value.freezeTokens) ||
    value.freezeTokens > MAX_FREEZE_TOKENS ||
    !isNullableDailyDate(value.lastCountedDate) ||
    !isNullableDailyDate(value.lastFreezeGrantDate) ||
    !isDenseArray(value.activeDays) ||
    typeof value.activeMonth !== 'string' ||
    !MONTH_RE.test(value.activeMonth)
  ) {
    return false;
  }
  const [yearText, monthText]: string[] = value.activeMonth.split('-');
  const daysInMonth: number = new Date(Number(yearText), Number(monthText), 0).getDate();
  return (
    value.activeDays.every(
      (day: unknown): boolean => isPositiveInteger(day) && day <= daysInMonth,
    ) && new Set<unknown>(value.activeDays).size === value.activeDays.length
  );
}

function hasValidSessionIdentity(value: UnknownRecord): boolean {
  return value.sessionId === undefined || isNonBlankString(value.sessionId);
}

function isEventRecordValue(value: unknown): value is EventRecord {
  if (!isRecord(value) || !isNonNegativeNumber(value.at) || !hasValidSessionIdentity(value)) {
    return false;
  }
  switch (value.t) {
    case 'sessionIdentityAssigned':
      return isNonNegativeNumber(value.startedAt) && isNonBlankString(value.sessionId);
    case 'sessionStarted':
      return (
        (value.source === 'manual' || value.source === 'schedule') &&
        (value.mode === 'blacklist' || value.mode === 'whitelist') &&
        (value.strictness === 'hard' || value.strictness === 'friction') &&
        isRelativeMinuteDuration(value.durationMin) &&
        typeof value.intention === 'string'
      );
    case 'sessionCompleted':
    case 'sessionCanceled':
      return isNonNegativeNumber(value.focusedMs);
    case 'phase':
      return (
        (value.from === 'idle' ||
          value.from === 'focus' ||
          value.from === 'break' ||
          value.from === 'paused') &&
        (value.to === 'idle' ||
          value.to === 'focus' ||
          value.to === 'break' ||
          value.to === 'paused')
      );
    case 'attempt':
      return (
        isNonBlankString(value.url) &&
        isNonBlankString(value.host) &&
        isNonNegativeInteger(value.tabId) &&
        (value.kind === 'navigation' || value.kind === 'existing')
      );
    case 'gateOpened':
    case 'gateResisted':
      return value.gate === 'pause' || value.gate === 'unlockSite' || value.gate === 'cancel';
    case 'budgetEarned':
    case 'pauseTaken':
      return isNonNegativeNumber(value.ms);
    case 'unlockTaken':
      return isNonBlankString(value.host) && isNonNegativeNumber(value.ms);
    default:
      return false;
  }
}

export function isEventRecord(value: unknown): value is EventRecord {
  return safelyValidate((): boolean => isEventRecordValue(value));
}

function isStatsBundleValue(value: unknown): value is StatsBundle {
  if (
    !isRecord(value) ||
    !isDenseArray(value.days) ||
    !value.days.every((day: unknown): boolean => parseDailyAgg(day) !== null) ||
    !isDenseArray(value.months) ||
    !value.months.every((month: unknown): boolean => parseMonthlyAgg(month) !== null) ||
    !isStreak(value.streak) ||
    !isDenseArray(value.recentSessions) ||
    !value.recentSessions.every(isEventRecord) ||
    !isRecord(value.totals)
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.totals.focusMsToday) &&
    isNonNegativeNumber(value.totals.focusMsWeek) &&
    isNonNegativeInteger(value.totals.attemptsToday) &&
    isNonNegativeInteger(value.totals.resistedToday)
  );
}

export function isStatsBundle(value: unknown): value is StatsBundle {
  return safelyValidate((): boolean => isStatsBundleValue(value));
}

export function ackError(value: unknown, malformedError: string): string | null {
  try {
    if (isRecord(value) && value.ok === true && hasExactKeys(value, ['ok'])) return null;
    if (
      isRecord(value) &&
      value.ok === false &&
      isNonBlankString(value.error) &&
      hasExactKeys(value, ['ok', 'error'])
    ) {
      const rejection: Ack = { ok: false, error: value.error };
      return rejection.error;
    }
    return malformedError;
  } catch {
    return malformedError;
  }
}

export function parseEventExportResponse(value: unknown): EventRecord[] | null {
  try {
    if (!isRecord(value) || typeof value.json !== 'string') return null;
    const parsed: unknown = JSON.parse(value.json);
    return isDenseArray(parsed) && parsed.every(isEventRecord) ? parsed : null;
  } catch {
    return null;
  }
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
