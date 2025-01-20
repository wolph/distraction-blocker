import { validateRule } from '../core/matcher';
import { validateEntry } from '../core/schedule';
import type { Request } from '../shared/messages';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionConfig,
  Settings,
} from '../shared/types';

const CATEGORY_IDS: readonly CategoryId[] = [
  'social',
  'video',
  'news',
  'mail',
  'shopping',
  'gaming',
  'forums',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys: PropertyKey[] = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key: PropertyKey): boolean => {
      return typeof key === 'string' && keys.includes(key);
    })
  );
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isValidUrl(value: unknown): value is string {
  if (!isNonBlankString(value) || value.trim() !== value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isValidHost(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.trim() === value &&
    validateRule({ kind: 'host', pattern: value }) === null
  );
}

function isCycleConfig(value: unknown): value is CycleConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['focusMin', 'shortBreakMin', 'longBreakMin', 'longEvery'])
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.focusMin) &&
    isNonNegativeNumber(value.shortBreakMin) &&
    isNonNegativeNumber(value.longBreakMin) &&
    isPositiveInteger(value.longEvery)
  );
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
    !isNonNegativeNumber(value.durationMin) ||
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

function isPauseSettings(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['earnRatio', 'capMs', 'pauseMs', 'unlockMs'])) {
    return false;
  }
  return (
    isNonNegativeNumber(value.earnRatio) &&
    isNonNegativeInteger(value.capMs) &&
    isNonNegativeInteger(value.pauseMs) &&
    isNonNegativeInteger(value.unlockMs)
  );
}

function isGateSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['delayMs', 'requireTypedPhrase']) &&
    isNonNegativeInteger(value.delayMs) &&
    typeof value.requireTypedPhrase === 'boolean'
  );
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
    !Array.isArray(value.days) ||
    value.days.length === 0 ||
    !value.days.every((day: unknown): day is number => isNonNegativeInteger(day) && day <= 6) ||
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

function isSettings(value: unknown): value is Settings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'presetsMin',
      'defaultMode',
      'defaultStrictness',
      'defaultCycling',
      'cyclingOnByDefault',
      'pause',
      'gate',
      'badgeCountdown',
      'sounds',
      'schedule',
      'streakGoalMin',
      'retentionDays',
    ])
  ) {
    return false;
  }
  return (
    Array.isArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isNonNegativeNumber) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' || value.defaultStrictness === 'friction') &&
    isCycleConfig(value.defaultCycling) &&
    typeof value.cyclingOnByDefault === 'boolean' &&
    isPauseSettings(value.pause) &&
    isGateSettings(value.gate) &&
    typeof value.badgeCountdown === 'boolean' &&
    isSoundSettings(value.sounds) &&
    Array.isArray(value.schedule) &&
    value.schedule.every(isScheduleEntry) &&
    isNonNegativeNumber(value.streakGoalMin) &&
    isNonNegativeInteger(value.retentionDays)
  );
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
  const rule: Rule = { kind: value.kind, pattern: value.pattern };
  return validateRule(rule) === null;
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
    !keys.every((key: PropertyKey): boolean => {
      return typeof key === 'string' && CATEGORY_IDS.includes(key as CategoryId);
    })
  ) {
    return false;
  }
  return keys.every((key: PropertyKey): boolean => {
    const hosts: unknown = value[key as string];
    return Array.isArray(hosts) && hosts.every(isValidHost);
  });
}

function isListsConfig(value: unknown): value is ListsConfig {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['custom', 'whitelist', 'categories', 'exclusions']) &&
    Array.isArray(value.custom) &&
    value.custom.every(isRule) &&
    Array.isArray(value.whitelist) &&
    value.whitelist.every(isRule) &&
    isCategories(value.categories) &&
    isExclusions(value.exclusions)
  );
}

function parseRecord(value: Record<string, unknown>): Request | null {
  switch (value.type) {
    case 'getSnapshot':
    case 'abandonGate':
    case 'resumeFromPause':
    case 'startNextFocusEarly':
    case 'getSettings':
    case 'getLists':
    case 'exportEvents':
      return hasExactKeys(value, ['type']) ? (value as Request) : null;
    case 'getBlockState':
      return hasExactKeys(value, ['type', 'url', 'docState']) &&
        isValidUrl(value.url) &&
        (value.docState === 'fresh' || value.docState === 'loaded')
        ? (value as Request)
        : null;
    case 'startSession':
      return hasExactKeys(value, ['type', 'config']) && isSessionConfig(value.config)
        ? (value as Request)
        : null;
    case 'openGate':
      if (
        !hasExactKeys(value, ['type', 'gate', 'host']) ||
        (value.gate !== 'pause' && value.gate !== 'unlockSite' && value.gate !== 'cancel')
      ) {
        return null;
      }
      return value.gate === 'unlockSite'
        ? isValidHost(value.host)
          ? (value as Request)
          : null
        : value.host === null
          ? (value as Request)
          : null;
    case 'confirmGate':
      return hasExactKeys(value, ['type', 'typedPhrase']) && isNullableString(value.typedPhrase)
        ? (value as Request)
        : null;
    case 'updateSettings':
      return hasExactKeys(value, ['type', 'settings']) && isSettings(value.settings)
        ? (value as Request)
        : null;
    case 'updateLists':
      return hasExactKeys(value, ['type', 'lists']) && isListsConfig(value.lists)
        ? (value as Request)
        : null;
    case 'getStats':
      return hasExactKeys(value, ['type', 'days']) && isPositiveInteger(value.days)
        ? (value as Request)
        : null;
    case 'previewSound':
      return hasExactKeys(value, ['type', 'sound']) &&
        (value.sound === 'sessionComplete' ||
          value.sound === 'breakStart' ||
          value.sound === 'breakEnd' ||
          value.sound === 'scheduleStart')
        ? (value as Request)
        : null;
    default:
      return null;
  }
}

export function parseRequest(value: unknown): Request | null {
  try {
    return isRecord(value) ? parseRecord(value) : null;
  } catch {
    return null;
  }
}
