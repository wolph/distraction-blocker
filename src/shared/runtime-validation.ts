import { validateRule } from '../core/matcher';
import { scheduleEntriesOverlap } from '../core/schedule';
import { isDailyDate, parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { CATEGORY_IDS, MAX_FREEZE_TOKENS } from './constants';
import type { Ack, StatsBundle } from './messages';
import {
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

const CLOCK_RE: RegExp = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MONTH_RE: RegExp = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_RE: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: UnknownRecord, keys: readonly string[]): boolean {
  const actual: string[] = Object.keys(value);
  return (
    actual.length === keys.length && keys.every((key: string): boolean => actual.includes(key))
  );
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

function clockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match: RegExpExecArray | null = CLOCK_RE.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

function isRule(value: unknown): value is Rule {
  if (
    !isRecord(value) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return false;
  }
  return validateRule({ kind: value.kind, pattern: value.pattern }) === null;
}

export function isCycleConfig(value: unknown): value is CycleConfig {
  return (
    isRecord(value) &&
    isRelativeMinuteDuration(value.focusMin) &&
    isRelativeMinuteDuration(value.shortBreakMin) &&
    isRelativeMinuteDuration(value.longBreakMin) &&
    isPositiveInteger(value.longEvery)
  );
}

function isScheduleEntry(value: unknown): value is ScheduleEntry {
  if (!isRecord(value) || !isNonBlankString(value.id) || !Array.isArray(value.days)) return false;
  const days: unknown[] = value.days;
  const startsAt: number | null = clockMinutes(value.start);
  const endsAt: number | null = clockMinutes(value.end);
  return (
    days.length > 0 &&
    days.every((day: unknown): boolean => isNonNegativeInteger(day) && day <= 6) &&
    new Set<unknown>(days).size === days.length &&
    startsAt !== null &&
    endsAt !== null &&
    startsAt < endsAt &&
    (value.mode === 'blacklist' || value.mode === 'whitelist') &&
    (value.strictness === 'hard' || value.strictness === 'friction') &&
    (value.cycling === null || isCycleConfig(value.cycling)) &&
    typeof value.intention === 'string' &&
    typeof value.enabled === 'boolean'
  );
}

function isSchedule(value: unknown): value is ScheduleEntry[] {
  if (!Array.isArray(value)) return false;
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

export function isPauseEconomy(value: unknown): value is PauseEconomy {
  return (
    isRecord(value) &&
    isNonNegativeNumber(value.earnRatio) &&
    isRelativeMillisecondDuration(value.capMs, true) &&
    isRelativeMillisecondDuration(value.pauseMs, false) &&
    isRelativeMillisecondDuration(value.unlockMs, false)
  );
}

export function isSettings(value: unknown): value is Settings {
  if (!isRecord(value)) return false;
  const gate: unknown = value.gate;
  const sounds: unknown = value.sounds;
  return (
    Array.isArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isRelativeMinuteDuration) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' || value.defaultStrictness === 'friction') &&
    isCycleConfig(value.defaultCycling) &&
    typeof value.cyclingOnByDefault === 'boolean' &&
    isPauseEconomy(value.pause) &&
    isRecord(gate) &&
    isRelativeMillisecondDuration(gate.delayMs, true) &&
    typeof gate.requireTypedPhrase === 'boolean' &&
    typeof value.badgeCountdown === 'boolean' &&
    typeof value.sessionCompleteNotification === 'boolean' &&
    isRecord(sounds) &&
    isFiniteNumber(sounds.masterVolume) &&
    sounds.masterVolume >= 0 &&
    sounds.masterVolume <= 1 &&
    typeof sounds.sessionComplete === 'boolean' &&
    typeof sounds.breakStart === 'boolean' &&
    typeof sounds.breakEnd === 'boolean' &&
    typeof sounds.scheduleStart === 'boolean' &&
    isSchedule(value.schedule) &&
    isPositiveInteger(value.streakGoalMin) &&
    isRelativeMinuteDuration(value.streakGoalMin) &&
    isSafeDayCount(value.streakFreezeIntervalDays) &&
    isSafeDayCount(value.retentionDays)
  );
}

export function isListsConfig(value: unknown): value is ListsConfig {
  if (!isRecord(value) || !isRecord(value.categories) || !isRecord(value.exclusions)) return false;
  if (!Array.isArray(value.custom) || !value.custom.every(isRule)) return false;
  if (!Array.isArray(value.whitelist) || !value.whitelist.every(isRule)) return false;
  const categories: UnknownRecord = value.categories;
  const exclusions: UnknownRecord = value.exclusions;
  return CATEGORY_IDS.every((id: CategoryId): boolean => {
    const excluded: unknown = exclusions[id];
    return (
      typeof categories[id] === 'boolean' &&
      (excluded === undefined ||
        (Array.isArray(excluded) &&
          excluded.every((host: unknown): boolean => isRule({ kind: 'host', pattern: host }))))
    );
  });
}

function isSessionConfig(value: unknown): value is SessionConfig {
  if (!isRecord(value)) return false;
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

export function isSessionSnapshot(value: unknown): value is SessionSnapshot {
  if (!isRecord(value)) return false;
  const phaseValid: boolean =
    value.phase === 'idle' ||
    value.phase === 'focus' ||
    value.phase === 'break' ||
    value.phase === 'paused';
  if (
    !isNonNegativeNumber(value.at) ||
    !phaseValid ||
    !isNonNegativeInteger(value.cycleIndex) ||
    !isNonNegativeNumber(value.bankMs) ||
    !isNonNegativeNumber(value.bankAccrualPerMs) ||
    !isRelativeMillisecondDuration(value.bankCapMs, true) ||
    !isRelativeMillisecondDuration(value.pauseCostMs, false) ||
    !isRelativeMillisecondDuration(value.unlockCostMs, false) ||
    !Array.isArray(value.activeUnlocks) ||
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
    !Array.isArray(value.activeDays) ||
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

export function isEventRecord(value: unknown): value is EventRecord {
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

export function isStatsBundle(value: unknown): value is StatsBundle {
  if (
    !isRecord(value) ||
    !Array.isArray(value.days) ||
    !value.days.every((day: unknown): boolean => parseDailyAgg(day) !== null) ||
    !Array.isArray(value.months) ||
    !value.months.every((month: unknown): boolean => parseMonthlyAgg(month) !== null) ||
    !isStreak(value.streak) ||
    !Array.isArray(value.recentSessions) ||
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

export function ackError(value: unknown, malformedError: string): string | null {
  if (isRecord(value) && value.ok === true && hasOnlyKeys(value, ['ok'])) return null;
  if (
    isRecord(value) &&
    value.ok === false &&
    isNonBlankString(value.error) &&
    hasOnlyKeys(value, ['ok', 'error'])
  ) {
    const rejection: Ack = { ok: false, error: value.error };
    return rejection.error;
  }
  return malformedError;
}

export function parseEventExportResponse(value: unknown): EventRecord[] | null {
  if (!isRecord(value) || typeof value.json !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value.json);
    return Array.isArray(parsed) && parsed.every(isEventRecord) ? parsed : null;
  } catch {
    return null;
  }
}

export function isDeviceId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
