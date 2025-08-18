import { normalizeSessionRules, validateRule } from '../core/matcher';
import { scheduleEntriesOverlap, validateEntry } from '../core/schedule';
import { isDailyDate, parseDailyAgg, parseMonthlyAgg } from '../core/stats';
import { CATEGORY_IDS, cancelPhrase, MAX_FREEZE_TOKENS } from './constants';
import type {
  Ack,
  OnboardingCleanupResponse,
  OnboardingCompletionResponse,
  OnboardingDraftLoadResponse,
  OnboardingDraftWriteResponse,
  RetrySyncResponse,
  StatsBundle,
  WebsiteAccessReconciliation,
} from './messages';
import {
  isPositiveMinuteValue,
  isRelativeMillisecondDuration,
  isRelativeMinuteDuration,
  isSafeDayCount,
} from './numeric-validation';
import type {
  CategoryId,
  CycleConfig,
  EndAuthorityV2,
  EventRecord,
  GateState,
  InstallMarker,
  ListsConfig,
  NormalizedScheduleEntryV1,
  OnboardingDraft,
  PausedFromStateV2,
  PauseEconomy,
  Phase,
  Rule,
  ScheduleDuration,
  ScheduleEntry,
  ScheduleEntryV2,
  ScheduleOccurrenceRef,
  SessionConfig,
  SessionConfigV2,
  SessionDuration,
  SessionEndedEventV2,
  SessionLifecycleV2,
  SessionMode,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionSnapshotV2,
  SessionStartedEventV2,
  SessionStateV2,
  Settings,
  SettingsV2,
  SetupState,
  SiteUnlock,
  StreakState,
  Strictness,
} from './types';

type UnknownRecord = Record<string, unknown>;
type StoredScheduleEntryShape = 'v1' | 'v2';

const MONTH_RE: RegExp = /^(\d{4})-(0[1-9]|1[0-2])$/;
const SCHEDULE_ENTRY_V1_KEYS: readonly string[] = [
  'id',
  'days',
  'start',
  'end',
  'mode',
  'strictness',
  'cycling',
  'intention',
  'enabled',
];
const SCHEDULE_ENTRY_V2_KEYS: readonly string[] = [
  'id',
  'days',
  'start',
  'end',
  'duration',
  'mode',
  'strictness',
  'cycling',
  'intention',
  'enabled',
];
const SETTINGS_KEYS: readonly string[] = [
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
];
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

function exactOwnDataSnapshot(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
    const snapshot: UnknownRecord = {};
    for (const key of keys) {
      const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
        value,
        key,
      );
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return null;
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function stableExactOwnDataSnapshot(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    const cloned: unknown = structuredClone(value);
    if (!hasOnlyOwnDataPropertiesDeep(value)) return null;
    if (!exactValueEqual(value, cloned)) return null;
    return exactOwnDataSnapshot(cloned, keys);
  } catch {
    return null;
  }
}

function isStructuredCloneableData(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function hasOnlyOwnDataPropertiesDeep(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
): boolean {
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (Array.isArray(value) && Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  for (const key of keys) {
    const descriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !Object.hasOwn(descriptor, 'value') ||
      !hasOnlyOwnDataPropertiesDeep(descriptor.value, seen)
    ) {
      return false;
    }
  }
  return true;
}

function exactKeysMatch(actual: readonly PropertyKey[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length &&
    actual.every((key: PropertyKey): boolean => typeof key === 'string' && expected.includes(key))
  );
}

function storedScheduleEntryShape(value: unknown): StoredScheduleEntryShape | null {
  if (!isRecord(value)) return null;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (exactKeysMatch(keys, SCHEDULE_ENTRY_V1_KEYS)) return 'v1';
  if (exactKeysMatch(keys, SCHEDULE_ENTRY_V2_KEYS)) return 'v2';
  return null;
}

export function isSetupState(value: unknown): value is SetupState {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, [
        'version',
        'completed',
        'websiteAccess',
        'blockingRegistration',
        'websiteAccessNotice',
        'storageMode',
        'syncWriteStatus',
        'storageError',
        'dataClear',
        'legacyImported',
      ]) &&
      value.version === 1 &&
      typeof value.completed === 'boolean' &&
      (value.websiteAccess === 'pending' ||
        value.websiteAccess === 'granted' ||
        value.websiteAccess === 'denied') &&
      (value.blockingRegistration === 'unavailable' ||
        value.blockingRegistration === 'ready' ||
        value.blockingRegistration === 'error') &&
      (value.websiteAccessNotice === null ||
        value.websiteAccessNotice === 'revoked-during-session' ||
        value.websiteAccessNotice === 'registration-failed-during-session') &&
      (value.storageMode === null ||
        value.storageMode === 'local' ||
        value.storageMode === 'sync') &&
      (value.syncWriteStatus === 'idle' ||
        value.syncWriteStatus === 'pending' ||
        value.syncWriteStatus === 'error') &&
      (value.storageError === null ||
        value.storageError === 'legacy-migration-failed' ||
        value.storageError === 'sync-publish-failed' ||
        value.storageError === 'remote-deletion-failed' ||
        value.storageError === 'local-clear-failed') &&
      isRecord(value.dataClear) &&
      hasExactKeys(value.dataClear, ['status', 'scope', 'phase']) &&
      ((value.dataClear.status === 'idle' &&
        value.dataClear.scope === null &&
        value.dataClear.phase === null) ||
        ((value.dataClear.status === 'pending' || value.dataClear.status === 'error') &&
          (((value.dataClear.scope === 'synced-policy' || value.dataClear.scope === 'all') &&
            (value.dataClear.phase === 'remote' || value.dataClear.phase === 'local')) ||
            (value.dataClear.scope === 'local-history' &&
              (value.dataClear.phase === 'local' || value.dataClear.phase === 'runtime'))))) &&
      typeof value.legacyImported === 'boolean',
  );
}

export function isOnboardingDraft(value: unknown): value is OnboardingDraft {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, [
        'version',
        'revision',
        'step',
        'settings',
        'lists',
        'websiteAccessChoice',
        'syncEnabled',
      ]) &&
      value.version === 1 &&
      isNonNegativeInteger(value.revision) &&
      (value.step === 1 || value.step === 2 || value.step === 3) &&
      isSettings(value.settings) &&
      isListsConfig(value.lists) &&
      (value.websiteAccessChoice === 'pending' ||
        value.websiteAccessChoice === 'granted' ||
        value.websiteAccessChoice === 'denied' ||
        value.websiteAccessChoice === 'deferred' ||
        value.websiteAccessChoice === 'registration-error') &&
      typeof value.syncEnabled === 'boolean',
  );
}

function isOnboardingOperationalFailure(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['ok', 'error']) &&
    value.ok === false &&
    isNonBlankString(value.error)
  );
}

export function isOnboardingDraftLoadResponse(
  value: unknown,
): value is OnboardingDraftLoadResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'draft', 'invalid']) &&
        value.ok === true &&
        (value.draft === null || isOnboardingDraft(value.draft)) &&
        typeof value.invalid === 'boolean' &&
        (value.draft === null || value.invalid === false)),
  );
}

export function isOnboardingDraftWriteResponse(
  value: unknown,
): value is OnboardingDraftWriteResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'draft']) &&
        value.ok === true &&
        isOnboardingDraft(value.draft)) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'conflict', 'completed', 'draft']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.conflict === true &&
        typeof value.completed === 'boolean' &&
        (value.draft === null || isOnboardingDraft(value.draft))),
  );
}

export function isOnboardingCleanupResponse(value: unknown): value is OnboardingCleanupResponse {
  return isOnboardingActionResponse(value);
}

export function isOnboardingCompletionResponse(
  value: unknown,
): value is OnboardingCompletionResponse {
  return safelyValidate(
    (): boolean =>
      isOnboardingActionResponse(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'conflict', 'completed', 'draft']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.conflict === true &&
        typeof value.completed === 'boolean' &&
        (value.draft === null || isOnboardingDraft(value.draft))),
  );
}

export function isWebsiteAccessReconciliation(
  value: unknown,
): value is WebsiteAccessReconciliation {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'granted', 'registration']) &&
        value.ok === true &&
        ((value.granted === true && value.registration === 'ready') ||
          (value.granted === false && value.registration === 'unavailable'))) ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'granted', 'registration']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        typeof value.granted === 'boolean' &&
        value.registration === 'error') ||
      (isRecord(value) &&
        hasExactKeys(value, ['ok', 'error', 'registration']) &&
        value.ok === false &&
        isNonBlankString(value.error) &&
        value.registration === 'error'),
  );
}

function isOnboardingActionResponse(value: unknown): boolean {
  return safelyValidate(
    (): boolean =>
      isOnboardingOperationalFailure(value) ||
      (isRecord(value) && hasExactKeys(value, ['ok']) && value.ok === true),
  );
}

export function isInstallMarker(value: unknown): value is InstallMarker {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      hasExactKeys(value, ['version', 'profile', 'latestReason', 'extensionVersion']) &&
      value.version === 1 &&
      (value.profile === 'clean' || value.profile === 'legacy') &&
      (value.latestReason === 'install' || value.latestReason === 'update') &&
      isNonBlankString(value.extensionVersion),
  );
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

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function exactDenseArrayLength(value: unknown[]): number | null {
  const lengthDescriptor: PropertyDescriptor | undefined = Reflect.getOwnPropertyDescriptor(
    value,
    'length',
  );
  if (
    lengthDescriptor === undefined ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    return null;
  }
  const length: number = lengthDescriptor.value;
  if (Reflect.ownKeys(value).length !== length + 1) return null;
  for (let index: number = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) return null;
  }
  return length;
}

function exactValueEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    const leftLength: number | null = exactDenseArrayLength(left);
    const rightLength: number | null = exactDenseArrayLength(right);
    if (leftLength === null || rightLength === null || leftLength !== rightLength) return false;
    for (let index: number = 0; index < leftLength; index++) {
      if (!exactValueEqual(left[index], right[index])) return false;
    }
    return true;
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys: string[] = Reflect.ownKeys(left).filter(
    (key: PropertyKey): key is string => typeof key === 'string',
  );
  const rightKeys: string[] = Reflect.ownKeys(right).filter(
    (key: PropertyKey): key is string => typeof key === 'string',
  );
  if (
    leftKeys.length !== Reflect.ownKeys(left).length ||
    rightKeys.length !== Reflect.ownKeys(right).length ||
    leftKeys.length !== rightKeys.length ||
    !leftKeys.every((key: string): boolean => rightKeys.includes(key))
  ) {
    return false;
  }
  return leftKeys.every((key: string): boolean => exactValueEqual(left[key], right[key]));
}

function isCanonicalSessionRuleSnapshotValue(value: unknown): value is SessionRuleSnapshot {
  const normalized: SessionRuleSnapshot | null = normalizeSessionRules(value);
  return normalized !== null && exactValueEqual(value, normalized);
}

export function isCanonicalSessionRuleSnapshot(value: unknown): value is SessionRuleSnapshot {
  return safelyValidate((): boolean => isCanonicalSessionRuleSnapshotValue(value));
}

function isLocalDateValue(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [yearText, monthText, dayText]: string[] = value.split('-');
  const year: number = Number(yearText);
  const month: number = Number(monthText);
  const day: number = Number(dayText);
  const candidate: Date = new Date(Date.UTC(year, month - 1, day));
  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function sessionDurationSnapshot(value: unknown): SessionDuration | null {
  const timed: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind', 'minutes']);
  if (
    timed !== null &&
    timed.kind === 'timed' &&
    isRelativeMinuteDuration(timed.minutes) &&
    isStructuredCloneableData(value)
  ) {
    return { kind: 'timed', minutes: timed.minutes };
  }
  const indefinite: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind']);
  if (
    indefinite !== null &&
    indefinite.kind === 'until-stopped' &&
    isStructuredCloneableData(value)
  ) {
    return { kind: 'until-stopped' };
  }
  return null;
}

function isSessionDurationValue(value: unknown): value is SessionDuration {
  return sessionDurationSnapshot(value) !== null;
}

export function isSessionDuration(value: unknown): value is SessionDuration {
  return safelyValidate((): boolean => isSessionDurationValue(value));
}

function isScheduleDurationValue(value: unknown): value is ScheduleDuration {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind']) &&
    (value.kind === 'window' || value.kind === 'until-stopped')
  );
}

export function isScheduleDuration(value: unknown): value is ScheduleDuration {
  return safelyValidate((): boolean => isScheduleDurationValue(value));
}

function isScheduleOccurrenceRefValue(value: unknown): value is ScheduleOccurrenceRef {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, [
    'version',
    'token',
    'entryId',
    'localStartDate',
  ]);
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isNonBlankString(candidate.entryId) &&
    isLocalDateValue(candidate.localStartDate) &&
    candidate.token === `${candidate.entryId}@${candidate.localStartDate}`
  );
}

export function isScheduleOccurrenceRef(value: unknown): value is ScheduleOccurrenceRef {
  return safelyValidate((): boolean => isScheduleOccurrenceRefValue(value));
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
    !hasExactKeys(value, SCHEDULE_ENTRY_V1_KEYS) ||
    !isNonBlankString(value.id) ||
    !isDenseArray(value.days) ||
    value.days.length === 0 ||
    !value.days.every((day: unknown): day is number => isNonNegativeInteger(day) && day <= 6) ||
    new Set(value.days).size !== value.days.length ||
    typeof value.start !== 'string' ||
    typeof value.end !== 'string' ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'flexible' &&
      value.strictness !== 'hard' &&
      value.strictness !== 'friction') ||
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

function isScheduleEntryV2Value(value: unknown): value is ScheduleEntryV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, SCHEDULE_ENTRY_V2_KEYS) ||
    !isScheduleDurationValue(value.duration)
  ) {
    return false;
  }
  const legacyShape: NormalizedScheduleEntryV1 = {
    id: value.id as string,
    days: value.days as number[],
    start: value.start as string,
    end: value.end as string,
    mode: value.mode as SessionMode,
    strictness: value.strictness as Strictness,
    cycling: value.cycling as CycleConfig | null,
    intention: value.intention as string,
    enabled: value.enabled as boolean,
  };
  if (!isScheduleEntry(legacyShape)) return false;
  return (
    value.duration.kind === 'window' || (value.strictness === 'flexible' && value.cycling === null)
  );
}

export function isScheduleEntryV2(value: unknown): value is ScheduleEntryV2 {
  return safelyValidate((): boolean => isScheduleEntryV2Value(value));
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
  if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) {
    return false;
  }
  return (
    isThemeMode(value.theme) &&
    isDenseArray(value.presetsMin) &&
    value.presetsMin.length === 3 &&
    value.presetsMin.every(isRelativeMinuteDuration) &&
    (value.defaultMode === 'blacklist' || value.defaultMode === 'whitelist') &&
    (value.defaultStrictness === 'hard' ||
      value.defaultStrictness === 'friction' ||
      value.defaultStrictness === 'flexible') &&
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

function parseStoredScheduleEntryV2(value: unknown): ScheduleEntryV2 | null {
  try {
    const sourceShape: StoredScheduleEntryShape | null = storedScheduleEntryShape(value);
    if (sourceShape === null) return null;
    const candidate: unknown = structuredClone(value);
    if (sourceShape === 'v2') return isScheduleEntryV2Value(candidate) ? candidate : null;
    if (!isScheduleEntry(candidate)) return null;
    return { ...candidate, duration: { kind: 'window' } };
  } catch {
    return null;
  }
}

export function parseStoredSettingsV2(value: unknown): SettingsV2 | null {
  try {
    if (!isRecord(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null;
    const storedSchedule: unknown = value.schedule;
    if (!isDenseArray(storedSchedule)) return null;
    const baseSource: UnknownRecord = {};
    for (let keyIndex: number = 0; keyIndex < SETTINGS_KEYS.length; keyIndex++) {
      const key: string = SETTINGS_KEYS[keyIndex] as string;
      if (key !== 'schedule') baseSource[key] = value[key];
    }
    baseSource.schedule = [];
    const baseCandidate: UnknownRecord = structuredClone(baseSource);
    if (!isSettingsValue(baseCandidate)) return null;
    const schedule: ScheduleEntryV2[] = [];
    for (let index: number = 0; index < storedSchedule.length; index++) {
      const candidate: unknown = storedSchedule[index];
      const parsed: ScheduleEntryV2 | null = parseStoredScheduleEntryV2(candidate);
      if (parsed === null) return null;
      schedule.push(parsed);
    }
    const ids: Set<string> = new Set<string>();
    for (let index: number = 0; index < schedule.length; index++) {
      const entry: ScheduleEntryV2 = schedule[index] as ScheduleEntryV2;
      if (ids.has(entry.id)) return null;
      ids.add(entry.id);
      for (let priorIndex: number = 0; priorIndex < index; priorIndex++) {
        const prior: ScheduleEntryV2 = schedule[priorIndex] as ScheduleEntryV2;
        if (scheduleEntriesOverlap(prior, entry)) return null;
      }
    }
    return { ...(baseCandidate as Settings), schedule };
  } catch {
    return null;
  }
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
      'rules',
    ])
  ) {
    return false;
  }
  if (
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'flexible' &&
      value.strictness !== 'hard' &&
      value.strictness !== 'friction') ||
    !isRelativeMinuteDuration(value.durationMin) ||
    (value.cycling !== null && !isCycleConfig(value.cycling)) ||
    typeof value.intention !== 'string' ||
    (value.source !== 'manual' && value.source !== 'schedule') ||
    !isNullableString(value.scheduleEntryId) ||
    normalizeSessionRules(value.rules) === null
  ) {
    return false;
  }
  return (
    (value.source === 'manual' && value.scheduleEntryId === null) ||
    (value.source === 'schedule' && isNonBlankString(value.scheduleEntryId))
  );
}

function isSessionConfigV2Value(value: unknown): value is SessionConfigV2 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'mode',
      'strictness',
      'duration',
      'cycling',
      'intention',
      'source',
      'scheduleOccurrence',
      'rules',
    ]) ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'flexible' &&
      value.strictness !== 'friction' &&
      value.strictness !== 'hard') ||
    !isSessionDurationValue(value.duration) ||
    (value.cycling !== null && !isCycleConfigValue(value.cycling)) ||
    typeof value.intention !== 'string' ||
    (value.source !== 'manual' && value.source !== 'schedule') ||
    !isCanonicalSessionRuleSnapshotValue(value.rules)
  ) {
    return false;
  }
  if (value.duration.kind === 'until-stopped') {
    if (value.strictness !== 'flexible' || value.cycling !== null) return false;
  }
  return value.source === 'manual'
    ? value.scheduleOccurrence === null
    : isScheduleOccurrenceRefValue(value.scheduleOccurrence);
}

export function isSessionConfigV2(value: unknown): value is SessionConfigV2 {
  return safelyValidate((): boolean => isSessionConfigV2Value(value));
}

function isPausedFromStateV2Value(value: unknown): value is PausedFromStateV2 {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['phase', 'phaseEndsAt']);
  return (
    candidate !== null &&
    (candidate.phase === 'focus' || candidate.phase === 'break') &&
    (candidate.phaseEndsAt === null || isSafeTimestamp(candidate.phaseEndsAt)) &&
    isStructuredCloneableData(value)
  );
}

function isSessionStateV2Value(value: unknown): value is SessionStateV2 {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, [
    'version',
    'sessionId',
    'config',
    'startedAt',
    'sessionEndsAt',
    'phase',
    'phaseStartedAt',
    'phaseEndsAt',
    'cycleIndex',
    'pausedFrom',
    'focusedMs',
  ]);
  const config: UnknownRecord | null = exactOwnDataSnapshot(candidate?.config, [
    'mode',
    'strictness',
    'duration',
    'cycling',
    'intention',
    'source',
    'scheduleOccurrence',
    'rules',
  ]);
  if (
    candidate === null ||
    config === null ||
    !hasOnlyOwnDataPropertiesDeep(value) ||
    candidate.version !== 2 ||
    !isUuid(candidate.sessionId) ||
    !isSessionConfigV2Value(config) ||
    !isSafeTimestamp(candidate.startedAt) ||
    !isSafeTimestamp(candidate.phaseStartedAt) ||
    candidate.phaseStartedAt < candidate.startedAt ||
    !isNonNegativeInteger(candidate.cycleIndex) ||
    !isSafeTimestamp(candidate.focusedMs) ||
    (candidate.phase !== 'focus' && candidate.phase !== 'break' && candidate.phase !== 'paused') ||
    !isStructuredCloneableData(value)
  ) {
    return false;
  }
  if (config.duration.kind === 'until-stopped') {
    if (candidate.sessionEndsAt !== null || candidate.phase === 'break') return false;
    if (candidate.phase === 'focus') {
      return candidate.phaseEndsAt === null && candidate.pausedFrom === null;
    }
    return (
      isSafeTimestamp(candidate.phaseEndsAt) &&
      candidate.phaseEndsAt >= candidate.phaseStartedAt &&
      isPausedFromStateV2Value(candidate.pausedFrom) &&
      candidate.pausedFrom.phase === 'focus' &&
      candidate.pausedFrom.phaseEndsAt === null
    );
  }
  const durationMs: number = Math.round(config.duration.minutes * 60_000);
  const expectedSessionEndsAt: number = candidate.startedAt + durationMs;
  if (
    !isSafeTimestamp(expectedSessionEndsAt) ||
    candidate.sessionEndsAt !== expectedSessionEndsAt ||
    !isSafeTimestamp(candidate.sessionEndsAt) ||
    !isSafeTimestamp(candidate.phaseEndsAt) ||
    candidate.phaseEndsAt < candidate.phaseStartedAt ||
    candidate.phaseEndsAt > candidate.sessionEndsAt
  ) {
    return false;
  }
  if (candidate.phase === 'focus') return candidate.pausedFrom === null;
  if (candidate.phase === 'break') {
    return config.cycling !== null && candidate.pausedFrom === null;
  }
  return (
    isPausedFromStateV2Value(candidate.pausedFrom) &&
    isSafeTimestamp(candidate.pausedFrom.phaseEndsAt) &&
    candidate.pausedFrom.phaseEndsAt >= candidate.phaseStartedAt &&
    candidate.pausedFrom.phaseEndsAt <= candidate.sessionEndsAt &&
    (candidate.pausedFrom.phase !== 'break' || config.cycling !== null)
  );
}

export function isSessionStateV2(value: unknown): value is SessionStateV2 {
  return safelyValidate((): boolean => isSessionStateV2Value(value));
}

function isExactGateState(value: unknown): value is GateState {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, [
    'kind',
    'host',
    'openedAt',
    'readyAt',
    'requiredPhrase',
  ]);
  return (
    candidate !== null &&
    hasOnlyOwnDataPropertiesDeep(value) &&
    isStructuredCloneableData(value) &&
    isGate(candidate) &&
    isSafeTimestamp(candidate.openedAt) &&
    isSafeTimestamp(candidate.readyAt)
  );
}

function isHiddenAuthority(value: unknown): value is { kind: 'hidden' } {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind']);
  return (
    candidate !== null &&
    candidate.kind === 'hidden' &&
    hasOnlyOwnDataPropertiesDeep(value) &&
    isStructuredCloneableData(value)
  );
}

function isEndAuthorityV2Value(value: unknown): value is EndAuthorityV2 {
  if (!hasOnlyOwnDataPropertiesDeep(value) || !isStructuredCloneableData(value)) return false;

  const hidden: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind']);
  if (hidden !== null) return hidden.kind === 'hidden';

  const immediate: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind', 'actionLabel']);
  if (immediate !== null) {
    return immediate.kind === 'immediate' && immediate.actionLabel === 'End session';
  }

  const friction: UnknownRecord | null = exactOwnDataSnapshot(value, [
    'kind',
    'gate',
    'copy',
    'actions',
  ]);
  if (friction === null || friction.kind !== 'friction-gate') return false;

  if (friction.gate === null) {
    const copy: UnknownRecord | null = exactOwnDataSnapshot(friction.copy, ['actionLabel']);
    const actions: UnknownRecord | null = exactOwnDataSnapshot(friction.actions, ['open']);
    return (
      copy !== null &&
      copy.actionLabel === 'End session' &&
      actions !== null &&
      actions.open === 'open-end-gate'
    );
  }

  const copy: UnknownRecord | null = exactOwnDataSnapshot(friction.copy, [
    'title',
    'back',
    'phraseLabel',
    'confirm',
    'intentionReminder',
  ]);
  const actions: UnknownRecord | null = exactOwnDataSnapshot(friction.actions, [
    'abandon',
    'confirm',
  ]);
  return (
    isExactGateState(friction.gate) &&
    friction.gate.kind === 'cancel' &&
    copy !== null &&
    copy.title === 'End this session' &&
    copy.back === 'Never mind, back to work' &&
    copy.phraseLabel === 'Type this to confirm:' &&
    copy.confirm === 'End the session' &&
    isNullableString(copy.intentionReminder) &&
    actions !== null &&
    actions.abandon === 'abandon-gate' &&
    actions.confirm === 'confirm-gate'
  );
}

export function isSessionLifecycleV2(value: unknown): value is SessionLifecycleV2 {
  return safelyValidate((): boolean => {
    if (!hasOnlyOwnDataPropertiesDeep(value) || !isStructuredCloneableData(value)) return false;

    const simple: UnknownRecord | null = exactOwnDataSnapshot(value, ['kind', 'endAuthority']);
    if (simple !== null) {
      if (simple.kind === 'idle') return isHiddenAuthority(simple.endAuthority);
      return simple.kind === 'active' && isEndAuthorityV2Value(simple.endAuthority);
    }

    const starting: UnknownRecord | null = exactOwnDataSnapshot(value, [
      'kind',
      'operationId',
      'transition',
      'endAuthority',
    ]);
    if (starting !== null) {
      return (
        starting.kind === 'starting' &&
        isUuid(starting.operationId) &&
        (starting.transition === 'start' || starting.transition === 'resume') &&
        isEndAuthorityV2Value(starting.endAuthority)
      );
    }

    const cleanup: UnknownRecord | null = exactOwnDataSnapshot(value, [
      'kind',
      'journal',
      'id',
      'endAuthority',
    ]);
    if (cleanup !== null) {
      return (
        cleanup.kind === 'cleanup' &&
        (cleanup.journal === 'transition' || cleanup.journal === 'closure') &&
        isUuid(cleanup.id) &&
        isHiddenAuthority(cleanup.endAuthority)
      );
    }

    const error: UnknownRecord | null = exactOwnDataSnapshot(value, [
      'kind',
      'code',
      'retryAvailable',
      'endAuthority',
    ]);
    return (
      error !== null &&
      error.kind === 'error' &&
      (error.code === 'transition-cleanup-failed' || error.code === 'closure-cleanup-failed') &&
      error.retryAvailable === true &&
      isHiddenAuthority(error.endAuthority)
    );
  });
}

function isExactSiteUnlock(value: unknown, at: number): value is SiteUnlock {
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['host', 'until']);
  return (
    candidate !== null &&
    isNonBlankString(candidate.host) &&
    isSafeTimestamp(candidate.until) &&
    candidate.until > at
  );
}

function isExactActiveUnlocks(value: unknown, at: number): value is SiteUnlock[] {
  if (!Array.isArray(value)) return false;
  const length: number | null = exactDenseArrayLength(value);
  if (length === null) return false;
  for (let index: number = 0; index < length; index++) {
    if (!isExactSiteUnlock(value[index], at)) return false;
  }
  return true;
}

function isPhaseValue(value: unknown): value is Phase {
  return value === 'idle' || value === 'focus' || value === 'break' || value === 'paused';
}

function intentionReminder(config: SessionConfigV2): string | null {
  const intention: string = config.intention.trim();
  return intention === '' ? null : intention;
}

function authorityMatchesConfigAndGate(
  authority: EndAuthorityV2,
  config: SessionConfigV2,
  gate: GateState | null,
): boolean {
  const cancelGate: (GateState & { kind: 'cancel' }) | null =
    gate?.kind === 'cancel' ? { ...gate, kind: 'cancel' } : null;
  if (config.duration.kind === 'until-stopped' || config.strictness === 'flexible') {
    return authority.kind === 'immediate' && cancelGate === null;
  }
  if (config.strictness === 'hard') return authority.kind === 'hidden' && cancelGate === null;
  if (authority.kind !== 'friction-gate') return false;
  if (cancelGate === null) return authority.gate === null;
  const requiredPhrase: string | null = authority.gate?.requiredPhrase ?? null;
  return (
    authority.gate !== null &&
    exactValueEqual(authority.gate, cancelGate) &&
    (requiredPhrase === null || requiredPhrase === cancelPhrase(config.intention)) &&
    authority.copy.intentionReminder === intentionReminder(config)
  );
}

function isExactNextSchedule(value: unknown, at: number): boolean {
  if (value === null) return true;
  const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, ['entryId', 'startsAt']);
  return (
    candidate !== null &&
    isNonBlankString(candidate.entryId) &&
    isSafeTimestamp(candidate.startsAt) &&
    candidate.startsAt > at
  );
}

const SESSION_SNAPSHOT_V2_KEYS: readonly string[] = [
  'at',
  'theme',
  'lifecycle',
  'phase',
  'config',
  'startedAt',
  'phaseStartedAt',
  'phaseEndsAt',
  'sessionEndsAt',
  'sessionFocusedMs',
  'cycleIndex',
  'bankMs',
  'bankAccrualPerMs',
  'bankCapMs',
  'pauseCostMs',
  'unlockCostMs',
  'activeUnlocks',
  'gate',
  'attemptsToday',
  'scheduleActive',
  'nextSchedule',
];

function isSessionSnapshotV2Value(value: unknown): value is SessionSnapshotV2 {
  const candidate: UnknownRecord | null = stableExactOwnDataSnapshot(
    value,
    SESSION_SNAPSHOT_V2_KEYS,
  );
  if (
    candidate === null ||
    !isSafeTimestamp(candidate.at) ||
    !isThemeMode(candidate.theme) ||
    !isSessionLifecycleV2(candidate.lifecycle) ||
    !isPhaseValue(candidate.phase) ||
    !isSafeTimestamp(candidate.sessionFocusedMs) ||
    !isNonNegativeInteger(candidate.cycleIndex) ||
    !isNonNegativeNumber(candidate.bankMs) ||
    !isNonNegativeNumber(candidate.bankAccrualPerMs) ||
    !isSafeTimestamp(candidate.bankCapMs) ||
    candidate.bankMs > candidate.bankCapMs ||
    !isRelativeMillisecondDuration(candidate.pauseCostMs, true) ||
    !isRelativeMillisecondDuration(candidate.unlockCostMs, true) ||
    !isExactActiveUnlocks(candidate.activeUnlocks, candidate.at) ||
    (candidate.gate !== null &&
      (!isExactGateState(candidate.gate) || candidate.gate.openedAt > candidate.at)) ||
    !isNonNegativeInteger(candidate.attemptsToday) ||
    typeof candidate.scheduleActive !== 'boolean' ||
    !isExactNextSchedule(candidate.nextSchedule, candidate.at)
  ) {
    return false;
  }

  if (candidate.lifecycle.kind !== 'active') {
    return (
      candidate.phase === 'idle' &&
      candidate.config === null &&
      candidate.startedAt === null &&
      candidate.phaseStartedAt === null &&
      candidate.phaseEndsAt === null &&
      candidate.sessionEndsAt === null &&
      candidate.sessionFocusedMs === 0 &&
      candidate.cycleIndex === 0 &&
      candidate.bankAccrualPerMs === 0 &&
      candidate.gate === null &&
      candidate.scheduleActive === false &&
      candidate.activeUnlocks.length === 0
    );
  }

  if (
    candidate.phase === 'idle' ||
    !isSessionConfigV2Value(candidate.config) ||
    !isSafeTimestamp(candidate.startedAt) ||
    !isSafeTimestamp(candidate.phaseStartedAt) ||
    candidate.startedAt > candidate.at ||
    candidate.phaseStartedAt < candidate.startedAt ||
    candidate.phaseStartedAt > candidate.at ||
    candidate.sessionFocusedMs > candidate.at - candidate.startedAt ||
    (candidate.phase === 'focus' &&
      candidate.sessionFocusedMs < candidate.at - candidate.phaseStartedAt) ||
    (candidate.phase !== 'focus' &&
      candidate.sessionFocusedMs > candidate.phaseStartedAt - candidate.startedAt) ||
    (candidate.phase !== 'focus' && candidate.bankAccrualPerMs !== 0) ||
    candidate.scheduleActive !== (candidate.config.source === 'schedule') ||
    !authorityMatchesConfigAndGate(
      candidate.lifecycle.endAuthority,
      candidate.config,
      candidate.gate,
    )
  ) {
    return false;
  }

  if (candidate.config.duration.kind === 'until-stopped') {
    if (candidate.sessionEndsAt !== null || candidate.phase === 'break') return false;
    return candidate.phase === 'focus'
      ? candidate.phaseEndsAt === null
      : isSafeTimestamp(candidate.phaseEndsAt) &&
          candidate.phaseEndsAt > candidate.at &&
          candidate.phaseEndsAt >= candidate.phaseStartedAt;
  }

  const durationMs: number = Math.round(candidate.config.duration.minutes * 60_000);
  const expectedSessionEndsAt: number = candidate.startedAt + durationMs;
  return (
    isSafeTimestamp(expectedSessionEndsAt) &&
    candidate.sessionEndsAt === expectedSessionEndsAt &&
    isSafeTimestamp(candidate.sessionEndsAt) &&
    isSafeTimestamp(candidate.phaseEndsAt) &&
    candidate.sessionEndsAt > candidate.at &&
    candidate.phaseEndsAt >= candidate.phaseStartedAt &&
    candidate.phaseEndsAt > candidate.at &&
    candidate.phaseEndsAt <= candidate.sessionEndsAt &&
    (candidate.phase !== 'break' || candidate.config.cycling !== null)
  );
}

export function isSessionSnapshotV2(value: unknown): value is SessionSnapshotV2 {
  return safelyValidate((): boolean => isSessionSnapshotV2Value(value));
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
        (value.strictness === 'flexible' ||
          value.strictness === 'hard' ||
          value.strictness === 'friction') &&
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

function validSourceOccurrence(
  source: unknown,
  occurrence: unknown,
  allowMissingInvalidScheduled: boolean,
): boolean {
  if (source === 'manual') return occurrence === null;
  if (source !== 'schedule') return false;
  return (
    isScheduleOccurrenceRefValue(occurrence) ||
    (allowMissingInvalidScheduled && occurrence === null)
  );
}

export function isSessionStartedEventV2(value: unknown): value is SessionStartedEventV2 {
  return safelyValidate((): boolean => {
    const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, [
      'version',
      't',
      'eventId',
      'at',
      'sessionId',
      'source',
      'mode',
      'strictness',
      'duration',
      'intention',
      'scheduleOccurrence',
    ]);
    const duration: SessionDuration | null = sessionDurationSnapshot(candidate?.duration);
    if (
      candidate === null ||
      candidate.version !== 2 ||
      candidate.t !== 'sessionStarted' ||
      !isUuid(candidate.sessionId) ||
      candidate.eventId !== `${candidate.sessionId}:start` ||
      !isSafeTimestamp(candidate.at) ||
      (candidate.mode !== 'blacklist' && candidate.mode !== 'whitelist') ||
      (candidate.strictness !== 'flexible' &&
        candidate.strictness !== 'friction' &&
        candidate.strictness !== 'hard') ||
      duration === null ||
      typeof candidate.intention !== 'string' ||
      !validSourceOccurrence(candidate.source, candidate.scheduleOccurrence, false) ||
      !isStructuredCloneableData(value)
    ) {
      return false;
    }
    return duration.kind !== 'until-stopped' || candidate.strictness === 'flexible';
  });
}

function isEndReasonOutcomeDurationValid(value: UnknownRecord, duration: SessionDuration): boolean {
  switch (value.reason) {
    case 'timer-completed':
      return value.outcome === 'completed' && duration.kind === 'timed';
    case 'manual-completed':
      return value.outcome === 'completed' && duration.kind === 'until-stopped';
    case 'manual-canceled':
      return value.outcome === 'canceled' && duration.kind === 'timed';
    case 'website-access-lost':
    case 'content-registration-failed':
    case 'alarm-failed':
    case 'tab-enforcement-failed':
    case 'invalid-active-state':
      return value.outcome === 'canceled';
    default:
      return false;
  }
}

export function isSessionEndedEventV2(value: unknown): value is SessionEndedEventV2 {
  return safelyValidate((): boolean => {
    const candidate: UnknownRecord | null = exactOwnDataSnapshot(value, [
      'version',
      't',
      'eventId',
      'at',
      'sessionId',
      'outcome',
      'reason',
      'focusedMs',
      'duration',
      'source',
      'scheduleOccurrence',
    ]);
    const duration: SessionDuration | null = sessionDurationSnapshot(candidate?.duration);
    if (
      candidate === null ||
      candidate.version !== 2 ||
      candidate.t !== 'sessionEnded' ||
      !isUuid(candidate.sessionId) ||
      candidate.eventId !== `${candidate.sessionId}:end` ||
      !isSafeTimestamp(candidate.at) ||
      !isSafeTimestamp(candidate.focusedMs) ||
      duration === null ||
      !isEndReasonOutcomeDurationValid(candidate, duration) ||
      !isStructuredCloneableData(value)
    ) {
      return false;
    }
    const missingInvalidScheduled: boolean =
      candidate.reason === 'invalid-active-state' &&
      candidate.outcome === 'canceled' &&
      duration.kind === 'timed';
    return validSourceOccurrence(
      candidate.source,
      candidate.scheduleOccurrence,
      missingInvalidScheduled,
    );
  });
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
    !isRecord(value.totals) ||
    !hasExactKeys(value.totals, [
      'focusMsToday',
      'focusMsLast7Days',
      'attemptsToday',
      'resistedToday',
    ])
  ) {
    return false;
  }
  return (
    isNonNegativeNumber(value.totals.focusMsToday) &&
    isNonNegativeNumber(value.totals.focusMsLast7Days) &&
    isNonNegativeInteger(value.totals.attemptsToday) &&
    isNonNegativeInteger(value.totals.resistedToday)
  );
}

export function isStatsBundle(value: unknown): value is StatsBundle {
  return safelyValidate((): boolean => isStatsBundleValue(value));
}

export function ackError(value: unknown, malformedError: string): string | null {
  if (!isAck(value)) return malformedError;
  return value.ok ? null : value.error;
}

export function isRetrySyncResponse(value: unknown): value is RetrySyncResponse {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      ((value.ok === true &&
        value.syncWriteStatus === 'idle' &&
        hasExactKeys(value, ['ok', 'syncWriteStatus'])) ||
        (value.ok === false &&
          isNonBlankString(value.error) &&
          hasExactKeys(value, ['ok', 'error']))),
  );
}

export function isAck(value: unknown): value is Ack {
  return safelyValidate(
    (): boolean =>
      isRecord(value) &&
      ((value.ok === true && hasExactKeys(value, ['ok'])) ||
        (value.ok === false &&
          isNonBlankString(value.error) &&
          hasExactKeys(value, ['ok', 'error']))),
  );
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
