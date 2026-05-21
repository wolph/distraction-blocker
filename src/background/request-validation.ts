import { validateRule } from '../core/matcher';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import { CATEGORY_IDS } from '../shared/constants';
import type { Request } from '../shared/messages';
import {
  isPositiveMinuteValue,
  isRelativeMillisecondDuration,
  isRelativeMinuteDuration,
  isSafeDayCount,
} from '../shared/numeric-validation';
import { SYNC_SETTINGS } from '../shared/storage-keys';
import type {
  CategoryId,
  CycleConfig,
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionConfig,
  Settings,
} from '../shared/types';
import { isBrowserTabId } from '../shared/work-target';
import { canEncodeListsForSync } from './list-sync-codec';
import { assertSyncItemWithinQuota } from './sync-quota';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  for (let index: number = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
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
  return isNonNegativeNumber(value) && Number.isSafeInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
  return isNonNegativeInteger(value) && value > 0;
}

function isWithinSyncQuota(key: string, value: unknown): boolean {
  try {
    assertSyncItemWithinQuota(key, value);
    return true;
  } catch {
    return false;
  }
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

function isValidRuleHost(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value.trim() === value &&
    validateRule({ kind: 'host', pattern: value }) === null
  );
}

function isBrowserHostname(value: unknown): value is string {
  if (!isNonBlankString(value) || value.trim() !== value) return false;
  try {
    const parsed: URL = new URL(`http://${value}/`);
    return parsed.hostname === value;
  } catch {
    return false;
  }
}

function isCycleConfig(value: unknown): value is CycleConfig {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['focusMin', 'shortBreakMin', 'longBreakMin', 'longEvery'])
  ) {
    return false;
  }
  return (
    isRelativeMinuteDuration(value.focusMin) &&
    isRelativeMinuteDuration(value.shortBreakMin) &&
    isRelativeMinuteDuration(value.longBreakMin) &&
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

function isPauseSettings(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, ['earnRatio', 'capMs', 'pauseMs', 'unlockMs'])) {
    return false;
  }
  return (
    isNonNegativeNumber(value.earnRatio) &&
    isNonNegativeInteger(value.capMs) &&
    isRelativeMillisecondDuration(value.pauseMs, true) &&
    isRelativeMillisecondDuration(value.unlockMs, true)
  );
}

function isGateSettings(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['delayMs', 'requireTypedPhrase', 'allowForceEnd']) &&
    isRelativeMillisecondDuration(value.delayMs, true) &&
    typeof value.requireTypedPhrase === 'boolean' &&
    typeof value.allowForceEnd === 'boolean'
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
  if (!isDenseArray(value) || !value.every(isScheduleEntry)) return false;
  const ids: Set<string> = new Set<string>();
  for (let index: number = 0; index < value.length; index++) {
    const entry: ScheduleEntry = value[index] as ScheduleEntry;
    if (ids.has(entry.id)) return false;
    ids.add(entry.id);
    for (let previousIndex: number = 0; previousIndex < index; previousIndex++) {
      const previous: ScheduleEntry = value[previousIndex] as ScheduleEntry;
      if (scheduleEntriesOverlap(previous, entry)) return false;
    }
  }
  return true;
}

function isSettings(value: unknown): value is Settings {
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
    isPauseSettings(value.pause) &&
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
    return isDenseArray(hosts) && hosts.every(isValidRuleHost);
  });
}

function isListsConfig(value: unknown): value is ListsConfig {
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

function parseListsConfigForSync(value: unknown): ListsConfig | null {
  let snapshot: unknown;
  try {
    const serialized: string | undefined = JSON.stringify(value);
    if (serialized === undefined) return null;
    snapshot = JSON.parse(serialized) as unknown;
  } catch (_error: unknown) {
    return null;
  }
  return isListsConfig(snapshot) && canEncodeListsForSync(snapshot) ? snapshot : null;
}

function parseRecord(value: Record<string, unknown>): Request | null {
  switch (value.type) {
    case 'getSnapshot':
    case 'abandonGate':
    case 'forceEndGate':
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
      return isSessionConfig(value.config) &&
        (hasExactKeys(value, ['type', 'config']) ||
          (hasExactKeys(value, ['type', 'config', 'workTabId', 'windowId']) &&
            isBrowserTabId(value.workTabId) &&
            isBrowserTabId(value.windowId)))
        ? (value as Request)
        : null;
    case 'getWorkTabs':
      return hasExactKeys(value, ['type', 'mode', 'windowId']) &&
        (value.mode === 'blacklist' || value.mode === 'whitelist') &&
        isBrowserTabId(value.windowId)
        ? (value as Request)
        : null;
    case 'getWorkTarget':
      return hasExactKeys(value, ['type']) ||
        (hasExactKeys(value, ['type', 'windowId']) && isBrowserTabId(value.windowId))
        ? (value as Request)
        : null;
    case 'setWorkTarget':
      return hasExactKeys(value, ['type', 'sessionId', 'tabId', 'windowId']) &&
        isNonBlankString(value.sessionId) &&
        isBrowserTabId(value.tabId) &&
        isBrowserTabId(value.windowId)
        ? (value as Request)
        : null;
    case 'returnToWork':
      return isNonBlankString(value.sessionId) &&
        (hasExactKeys(value, ['type', 'sessionId']) ||
          (hasExactKeys(value, ['type', 'sessionId', 'windowId']) &&
            isBrowserTabId(value.windowId)))
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
        ? isBrowserHostname(value.host)
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
      return hasExactKeys(value, ['type', 'settings']) &&
        isWithinSyncQuota(SYNC_SETTINGS, value.settings) &&
        isSettings(value.settings)
        ? (value as Request)
        : null;
    case 'updateTheme':
      return hasExactKeys(value, ['type', 'theme']) && isThemeMode(value.theme)
        ? (value as Request)
        : null;
    case 'updateLists': {
      if (!hasExactKeys(value, ['type', 'lists'])) return null;
      const lists: ListsConfig | null = parseListsConfigForSync(value.lists);
      return lists === null ? null : { type: 'updateLists', lists };
    }
    case 'getStats':
      return hasExactKeys(value, ['type', 'days']) && isSafeDayCount(value.days)
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
