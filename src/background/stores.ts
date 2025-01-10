import { type StoredMatcherCache, validateRule } from '../core/matcher';
import { isDailyDate, parseDailyAgg } from '../core/stats';
import {
  DEFAULT_LISTS,
  DEFAULT_SETTINGS,
  EVENT_LOG_CAP,
  MAX_FREEZE_TOKENS,
} from '../shared/constants';
import {
  LOCAL_CACHES,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_RUNTIME,
  LOCAL_SYNC_JOURNAL,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
} from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  BankState,
  CategoryId,
  CycleConfig,
  DailyAgg,
  EventRecord,
  GateState,
  ListsConfig,
  Rule,
  ScheduleEntry,
  SessionConfig,
  SessionState,
  Settings,
  SiteUnlock,
  StreakState,
} from '../shared/types';
import type { SyncJournal } from './sync-writer';

const CATEGORY_IDS: readonly CategoryId[] = [
  'social',
  'video',
  'news',
  'mail',
  'shopping',
  'gaming',
  'forums',
];
const TIME_RE: RegExp = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * Background-internal persisted state. Not part of the shared contract:
 * only the worker reads or writes it.
 *
 * todayAgg stays null until the first event of the day folds in. Minting
 * an empty DailyAgg is core's job, so the boot path does not depend on it.
 */
export interface RuntimeState {
  session: SessionState | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  tabStates: Record<number, RuntimeTabState>;
  /** focus ms of the current session already credited to the pause bank */
  accruedFocusMs: number;
  /** "tabId:url" -> last attempt timestamp, for the 30 s attempt debounce */
  attemptDebounce: Record<string, number>;
  scheduleActiveEntryId: string | null;
  /** local date todayAgg belongs to, watermark for the midnight rollover */
  date: string;
  todayAgg: DailyAgg | null;
  /** last date the weekly sync prune ran, null before the first run */
  lastPruneDate: string | null;
  /** Durable recovery record cleared after events, sync journal, and runtime agree. */
  commitCheckpoint: RuntimeCommitCheckpoint | null;
}

export interface RuntimeCommitCheckpoint {
  bank: BankState;
  events: EventRecord[];
  syncBank: boolean;
}

export interface RuntimeTabState {
  muteUrl: string | null;
  priorMuted: boolean | null;
  stoppedDocumentId: string | null;
}

export function emptyRuntime(now: number): RuntimeState {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    scheduleActiveEntryId: null,
    date: localDateStr(now),
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
  };
}

export async function loadSettings(journal?: SyncJournal): Promise<Settings> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_SETTINGS))[SYNC_SETTINGS];
  return mergeSettings(journalValue(journal, SYNC_SETTINGS, raw));
}

export async function loadLists(journal?: SyncJournal): Promise<ListsConfig> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_LISTS))[SYNC_LISTS];
  return mergeLists(journalValue(journal, SYNC_LISTS, raw));
}

export function mergeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
  const pause: Record<string, unknown> = isRecord(stored.pause) ? stored.pause : {};
  const gate: Record<string, unknown> = isRecord(stored.gate) ? stored.gate : {};
  const sounds: Record<string, unknown> = isRecord(stored.sounds) ? stored.sounds : {};
  return {
    presetsMin: parsePresets(stored.presetsMin) ?? [...base.presetsMin],
    defaultMode:
      stored.defaultMode === 'blacklist' || stored.defaultMode === 'whitelist'
        ? stored.defaultMode
        : base.defaultMode,
    defaultStrictness:
      stored.defaultStrictness === 'hard' || stored.defaultStrictness === 'friction'
        ? stored.defaultStrictness
        : base.defaultStrictness,
    defaultCycling: parseCycleConfig(stored.defaultCycling) ?? { ...base.defaultCycling },
    cyclingOnByDefault:
      typeof stored.cyclingOnByDefault === 'boolean'
        ? stored.cyclingOnByDefault
        : base.cyclingOnByDefault,
    pause: {
      earnRatio: numberOrDefault(pause.earnRatio, base.pause.earnRatio),
      capMs: numberOrDefault(pause.capMs, base.pause.capMs),
      pauseMs: numberOrDefault(pause.pauseMs, base.pause.pauseMs),
      unlockMs: numberOrDefault(pause.unlockMs, base.pause.unlockMs),
    },
    gate: {
      delayMs: numberOrDefault(gate.delayMs, base.gate.delayMs),
      requireTypedPhrase:
        typeof gate.requireTypedPhrase === 'boolean'
          ? gate.requireTypedPhrase
          : base.gate.requireTypedPhrase,
    },
    badgeCountdown:
      typeof stored.badgeCountdown === 'boolean' ? stored.badgeCountdown : base.badgeCountdown,
    sounds: {
      masterVolume: isUnitNumber(sounds.masterVolume)
        ? sounds.masterVolume
        : base.sounds.masterVolume,
      sessionComplete:
        typeof sounds.sessionComplete === 'boolean'
          ? sounds.sessionComplete
          : base.sounds.sessionComplete,
      breakStart:
        typeof sounds.breakStart === 'boolean' ? sounds.breakStart : base.sounds.breakStart,
      breakEnd: typeof sounds.breakEnd === 'boolean' ? sounds.breakEnd : base.sounds.breakEnd,
      scheduleStart:
        typeof sounds.scheduleStart === 'boolean'
          ? sounds.scheduleStart
          : base.sounds.scheduleStart,
    },
    schedule: Array.isArray(stored.schedule)
      ? parseSchedule(stored.schedule)
      : structuredClone(base.schedule),
    streakGoalMin: numberOrDefault(stored.streakGoalMin, base.streakGoalMin),
    retentionDays: numberOrDefault(stored.retentionDays, base.retentionDays),
  };
}

export function mergeLists(raw: unknown, base: ListsConfig = DEFAULT_LISTS): ListsConfig {
  const stored: Record<string, unknown> = isRecord(raw) ? raw : {};
  return {
    custom: Array.isArray(stored.custom) ? parseRules(stored.custom) : structuredClone(base.custom),
    whitelist: Array.isArray(stored.whitelist)
      ? parseRules(stored.whitelist)
      : structuredClone(base.whitelist),
    categories: parseCategories(stored.categories, base.categories),
    exclusions: isRecord(stored.exclusions)
      ? parseExclusions(stored.exclusions)
      : structuredClone(base.exclusions),
  };
}

export function parseLiveSettings(value: unknown, current: Settings): Settings | null {
  if (!isRecord(value)) return null;
  const parsed: Settings = mergeSettings(value, current);
  parsed.schedule = parseStrictLiveSchedule(value.schedule, current.schedule);
  return JSON.stringify(parsed) === JSON.stringify(current) ? null : parsed;
}

export function parseLiveLists(value: unknown, current: ListsConfig): ListsConfig | null {
  if (!isRecord(value)) return null;
  const parsed: ListsConfig = mergeLists(value, current);
  parsed.custom = parseStrictLiveRules(value.custom, current.custom);
  parsed.whitelist = parseStrictLiveRules(value.whitelist, current.whitelist);
  parsed.exclusions = parseStrictLiveExclusions(value.exclusions, current.exclusions);
  return JSON.stringify(parsed) === JSON.stringify(current) ? null : parsed;
}

export async function loadBank(journal?: SyncJournal): Promise<BankState> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_BANK))[SYNC_BANK];
  return parseBank(journalValue(journal, SYNC_BANK, raw)) ?? { balanceMs: 0 };
}

/** Null when no streak has been persisted yet: minting one needs core's emptyStreak. */
export async function loadStreak(journal?: SyncJournal): Promise<StreakState | null> {
  const raw: unknown = (await chrome.storage.sync.get(SYNC_STREAK))[SYNC_STREAK];
  return parseStreak(journalValue(journal, SYNC_STREAK, raw));
}

export async function loadSyncJournal(): Promise<SyncJournal> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_SYNC_JOURNAL))[LOCAL_SYNC_JOURNAL];
  if (!isRecord(raw)) return { sets: {}, removes: [] };
  const sets: Record<string, unknown> = isRecord(raw.sets) ? raw.sets : {};
  const removes: string[] = Array.isArray(raw.removes)
    ? raw.removes.filter((key: unknown): key is string => typeof key === 'string')
    : [];
  return { sets, removes };
}

export async function saveSyncJournal(journal: SyncJournal): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_SYNC_JOURNAL]: journal });
}

function journalValue(journal: SyncJournal | undefined, key: string, stored: unknown): unknown {
  if (journal === undefined) return stored;
  if (journal.removes.includes(key)) return undefined;
  return Object.hasOwn(journal.sets, key) ? journal.sets[key] : stored;
}

export async function loadRuntime(now: number): Promise<RuntimeState> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_RUNTIME))[LOCAL_RUNTIME];
  return mergeRuntime(raw, now);
}

export function mergeRuntime(raw: unknown, now: number): RuntimeState {
  const empty: RuntimeState = emptyRuntime(now);
  if (!isRecord(raw)) return empty;
  const date: string = isDailyDate(raw.date) ? raw.date : empty.date;
  return {
    session: parseSession(raw.session),
    gate: parseGate(raw.gate),
    unlocks: parseUnlocks(raw.unlocks),
    tabStates: parseTabStates(raw.tabStates),
    accruedFocusMs: isNonNegativeNumber(raw.accruedFocusMs) ? raw.accruedFocusMs : 0,
    attemptDebounce: parseAttemptDebounce(raw.attemptDebounce),
    scheduleActiveEntryId: isNullableString(raw.scheduleActiveEntryId)
      ? raw.scheduleActiveEntryId
      : null,
    date,
    todayAgg: parseDailyAgg(raw.todayAgg, date),
    lastPruneDate: isDailyDate(raw.lastPruneDate) ? raw.lastPruneDate : null,
    commitCheckpoint: parseCommitCheckpoint(raw.commitCheckpoint),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && /\S/.test(value);
}

function numberOrDefault(value: unknown, fallback: number): number {
  return isNonNegativeNumber(value) ? value : fallback;
}

function isUnitNumber(value: unknown): value is number {
  return isNonNegativeNumber(value) && value <= 1;
}

function parsePresets(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [first, second, third] = value;
  if (!isNonNegativeNumber(first) || !isNonNegativeNumber(second) || !isNonNegativeNumber(third)) {
    return null;
  }
  return [first, second, third];
}

function parseCycleConfig(value: unknown): CycleConfig | null {
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeNumber(value.focusMin) ||
    !isNonNegativeNumber(value.shortBreakMin) ||
    !isNonNegativeNumber(value.longBreakMin) ||
    !isNonNegativeInteger(value.longEvery) ||
    value.longEvery === 0
  ) {
    return null;
  }
  return {
    focusMin: value.focusMin,
    shortBreakMin: value.shortBreakMin,
    longBreakMin: value.longBreakMin,
    longEvery: value.longEvery,
  };
}

function parseClockMinutes(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match: RegExpExecArray | null = TIME_RE.exec(value);
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
}

function parseScheduleEntry(value: unknown): ScheduleEntry | null {
  if (!isRecord(value) || !isNonBlankString(value.id)) return null;
  if (!Array.isArray(value.days) || value.days.length === 0) return null;
  if (typeof value.start !== 'string' || typeof value.end !== 'string') return null;
  const days: number[] = [];
  for (const day of value.days) {
    if (!isNonNegativeInteger(day) || day > 6) return null;
    days.push(day);
  }
  const startsAt: number | null = parseClockMinutes(value.start);
  const endsAt: number | null = parseClockMinutes(value.end);
  const cycling: CycleConfig | null = parseCycleConfig(value.cycling);
  if (
    startsAt === null ||
    endsAt === null ||
    startsAt >= endsAt ||
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'hard' && value.strictness !== 'friction') ||
    (value.cycling !== null && cycling === null) ||
    typeof value.intention !== 'string' ||
    typeof value.enabled !== 'boolean'
  ) {
    return null;
  }
  return {
    id: value.id,
    days,
    start: value.start,
    end: value.end,
    mode: value.mode,
    strictness: value.strictness,
    cycling,
    intention: value.intention,
    enabled: value.enabled,
  };
}

function parseSchedule(value: unknown): ScheduleEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ScheduleEntry[] = [];
  for (const candidate of value) {
    const entry: ScheduleEntry | null = parseScheduleEntry(candidate);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}

function parseStrictLiveSchedule(value: unknown, current: ScheduleEntry[]): ScheduleEntry[] {
  if (!Array.isArray(value)) return structuredClone(current);
  const entries: ScheduleEntry[] = [];
  for (const candidate of value) {
    const entry: ScheduleEntry | null = parseScheduleEntry(candidate);
    if (entry === null) return structuredClone(current);
    entries.push(entry);
  }
  return entries;
}

function parseRule(value: unknown): Rule | null {
  if (
    !isRecord(value) ||
    (value.kind !== 'host' && value.kind !== 'regex') ||
    typeof value.pattern !== 'string'
  ) {
    return null;
  }
  const rule: Rule = { kind: value.kind, pattern: value.pattern };
  return validateRule(rule) === null ? rule : null;
}

function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const rules: Rule[] = [];
  for (const candidate of value) {
    const rule: Rule | null = parseRule(candidate);
    if (rule !== null) rules.push(rule);
  }
  return rules;
}

function parseStrictLiveRules(value: unknown, current: Rule[]): Rule[] {
  if (!Array.isArray(value)) return structuredClone(current);
  const rules: Rule[] = [];
  for (const candidate of value) {
    const rule: Rule | null = parseRule(candidate);
    if (rule === null) return structuredClone(current);
    rules.push(rule);
  }
  return rules;
}

function parseCategories(
  value: unknown,
  base: ListsConfig['categories'] = DEFAULT_LISTS.categories,
): ListsConfig['categories'] {
  const stored: Record<string, unknown> = isRecord(value) ? value : {};
  const categories: ListsConfig['categories'] = { ...base };
  for (const id of CATEGORY_IDS) {
    if (typeof stored[id] === 'boolean') categories[id] = stored[id];
  }
  return categories;
}

function parseExclusions(value: unknown): ListsConfig['exclusions'] {
  if (!isRecord(value)) return {};
  const exclusions: ListsConfig['exclusions'] = {};
  for (const id of CATEGORY_IDS) {
    const candidates: unknown = value[id];
    if (!Array.isArray(candidates)) continue;
    const hosts: string[] = [];
    for (const candidate of candidates) {
      const rule: Rule | null = parseRule({ kind: 'host', pattern: candidate });
      if (rule !== null) hosts.push(rule.pattern);
    }
    exclusions[id] = hosts;
  }
  return exclusions;
}

function parseStrictLiveExclusions(
  value: unknown,
  current: ListsConfig['exclusions'],
): ListsConfig['exclusions'] {
  const exclusions: ListsConfig['exclusions'] = structuredClone(current);
  if (!isRecord(value)) return exclusions;
  for (const id of CATEGORY_IDS) {
    if (!Object.hasOwn(value, id)) continue;
    const candidates: unknown = value[id];
    if (!Array.isArray(candidates)) continue;
    const hosts: string[] = [];
    let valid: boolean = true;
    for (const candidate of candidates) {
      const rule: Rule | null = parseRule({ kind: 'host', pattern: candidate });
      if (rule === null) {
        valid = false;
        break;
      }
      hosts.push(rule.pattern);
    }
    if (valid) exclusions[id] = hosts;
  }
  return exclusions;
}

export function parseBank(value: unknown): BankState | null {
  if (!isRecord(value) || !isNonNegativeNumber(value.balanceMs)) return null;
  return { balanceMs: value.balanceMs };
}

function isMonth(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match: RegExpExecArray | null = /^(\d{4})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const month: number = Number(match[2]);
  return month >= 1 && month <= 12;
}

function isNullableDailyDate(value: unknown): value is string | null {
  return value === null || isDailyDate(value);
}

export function parseStreak(value: unknown): StreakState | null {
  if (!isRecord(value)) return null;
  if (
    !isNonNegativeInteger(value.current) ||
    !isNonNegativeInteger(value.freezeTokens) ||
    value.freezeTokens > MAX_FREEZE_TOKENS ||
    !isNullableDailyDate(value.lastCountedDate) ||
    !isNullableDailyDate(value.lastFreezeGrantDate) ||
    !Array.isArray(value.activeDays) ||
    !isMonth(value.activeMonth)
  ) {
    return null;
  }
  const [yearText, monthText] = value.activeMonth.split('-');
  const daysInMonth: number = new Date(Number(yearText), Number(monthText), 0).getDate();
  const activeDays: number[] = [];
  const seen: Set<number> = new Set();
  for (const day of value.activeDays) {
    if (!isNonNegativeInteger(day) || day === 0 || day > daysInMonth || seen.has(day)) return null;
    seen.add(day);
    activeDays.push(day);
  }
  return {
    current: value.current,
    freezeTokens: value.freezeTokens,
    lastCountedDate: value.lastCountedDate,
    lastFreezeGrantDate: value.lastFreezeGrantDate,
    activeDays,
    activeMonth: value.activeMonth,
  };
}

function parseSessionConfig(value: unknown): SessionConfig | null {
  if (!isRecord(value)) return null;
  const cycling: CycleConfig | null = parseCycleConfig(value.cycling);
  if (
    (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
    (value.strictness !== 'hard' && value.strictness !== 'friction') ||
    !isNonNegativeNumber(value.durationMin) ||
    (value.cycling !== null && cycling === null) ||
    typeof value.intention !== 'string' ||
    (value.source !== 'manual' && value.source !== 'schedule') ||
    !isNullableString(value.scheduleEntryId)
  ) {
    return null;
  }
  if (
    (value.source === 'manual' && value.scheduleEntryId !== null) ||
    (value.source === 'schedule' && value.scheduleEntryId === null)
  ) {
    return null;
  }
  return {
    mode: value.mode,
    strictness: value.strictness,
    durationMin: value.durationMin,
    cycling,
    intention: value.intention,
    source: value.source,
    scheduleEntryId: value.scheduleEntryId,
  };
}

function parsePausedFrom(value: unknown): { phase: 'focus' | 'break'; phaseEndsAt: number } | null {
  if (!isRecord(value)) return null;
  if (
    (value.phase !== 'focus' && value.phase !== 'break') ||
    !isNonNegativeNumber(value.phaseEndsAt)
  ) {
    return null;
  }
  return { phase: value.phase, phaseEndsAt: value.phaseEndsAt };
}

function parseSession(value: unknown): SessionState | null {
  if (!isRecord(value)) return null;
  const config: SessionConfig | null = parseSessionConfig(value.config);
  const pausedFrom = parsePausedFrom(value.pausedFrom);
  if (
    config === null ||
    (value.sessionId !== undefined && !isNonBlankString(value.sessionId)) ||
    (value.phase !== 'focus' && value.phase !== 'break' && value.phase !== 'paused') ||
    !isNonNegativeNumber(value.startedAt) ||
    !isNonNegativeNumber(value.sessionEndsAt) ||
    !isNonNegativeNumber(value.phaseStartedAt) ||
    !isNonNegativeNumber(value.phaseEndsAt) ||
    !isNonNegativeInteger(value.cycleIndex) ||
    !isNonNegativeNumber(value.focusedMs)
  ) {
    return null;
  }
  if (
    value.sessionEndsAt < value.startedAt ||
    value.phaseStartedAt < value.startedAt ||
    value.phaseEndsAt < value.startedAt ||
    (value.phase === 'paused' && value.phaseEndsAt < value.phaseStartedAt) ||
    (value.phase !== 'paused' && value.phaseEndsAt > value.sessionEndsAt) ||
    (value.phase === 'break' && config.cycling === null)
  ) {
    return null;
  }
  if (value.phase === 'paused') {
    if (
      pausedFrom === null ||
      pausedFrom.phaseEndsAt < value.phaseStartedAt ||
      pausedFrom.phaseEndsAt > value.sessionEndsAt
    ) {
      return null;
    }
  } else if (value.pausedFrom !== null && value.pausedFrom !== undefined) {
    return null;
  }
  const session: SessionState = {
    config,
    startedAt: value.startedAt,
    sessionEndsAt: value.sessionEndsAt,
    phase: value.phase,
    phaseStartedAt: value.phaseStartedAt,
    phaseEndsAt: value.phaseEndsAt,
    cycleIndex: value.cycleIndex,
    pausedFrom: value.phase === 'paused' ? pausedFrom : null,
    focusedMs: value.focusedMs,
  };
  if (isNonBlankString(value.sessionId)) session.sessionId = value.sessionId;
  return session;
}

function parseGate(value: unknown): GateState | null {
  if (!isRecord(value)) return null;
  if (
    (value.kind !== 'pause' && value.kind !== 'unlockSite' && value.kind !== 'cancel') ||
    !isNullableString(value.host) ||
    !isNonNegativeNumber(value.openedAt) ||
    !isNonNegativeNumber(value.readyAt) ||
    value.readyAt < value.openedAt ||
    !isNullableString(value.requiredPhrase)
  ) {
    return null;
  }
  if (
    (value.kind === 'unlockSite' && (value.host === null || value.host === '')) ||
    (value.kind !== 'unlockSite' && value.host !== null)
  ) {
    return null;
  }
  return {
    kind: value.kind,
    host: value.host,
    openedAt: value.openedAt,
    readyAt: value.readyAt,
    requiredPhrase: value.requiredPhrase,
  };
}

function parseUnlock(value: unknown): SiteUnlock | null {
  if (
    !isRecord(value) ||
    typeof value.host !== 'string' ||
    value.host === '' ||
    !isNonNegativeNumber(value.until)
  ) {
    return null;
  }
  return { host: value.host, until: value.until };
}

function parseUnlocks(value: unknown): SiteUnlock[] {
  if (!Array.isArray(value)) return [];
  const unlocks: SiteUnlock[] = [];
  for (const candidate of value) {
    const unlock: SiteUnlock | null = parseUnlock(candidate);
    if (unlock !== null) unlocks.push(unlock);
  }
  return unlocks;
}

function parseAttemptDebounce(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  const parsed: Record<string, number> = {};
  for (const [key, timestamp] of Object.entries(value)) {
    if (isNonNegativeNumber(timestamp)) parsed[key] = timestamp;
  }
  return parsed;
}

interface ParsedSessionIdentity {
  sessionId?: string;
}

function parseSessionIdentity(value: Record<string, unknown>): ParsedSessionIdentity | null {
  if (value.sessionId === undefined) return {};
  return isNonBlankString(value.sessionId) ? { sessionId: value.sessionId } : null;
}

function isPhase(value: unknown): value is 'idle' | 'focus' | 'break' | 'paused' {
  return value === 'idle' || value === 'focus' || value === 'break' || value === 'paused';
}

function isGateKind(value: unknown): value is 'pause' | 'unlockSite' | 'cancel' {
  return value === 'pause' || value === 'unlockSite' || value === 'cancel';
}

function parseEventRecord(value: unknown): EventRecord | null {
  if (!isRecord(value) || !isNonNegativeNumber(value.at)) return null;
  const identity: ParsedSessionIdentity | null = parseSessionIdentity(value);
  if (identity === null) return null;
  switch (value.t) {
    case 'sessionStarted':
      if (
        (value.source !== 'manual' && value.source !== 'schedule') ||
        (value.mode !== 'blacklist' && value.mode !== 'whitelist') ||
        (value.strictness !== 'hard' && value.strictness !== 'friction') ||
        !isNonNegativeNumber(value.durationMin) ||
        typeof value.intention !== 'string'
      ) {
        return null;
      }
      return {
        t: value.t,
        at: value.at,
        source: value.source,
        mode: value.mode,
        strictness: value.strictness,
        durationMin: value.durationMin,
        intention: value.intention,
        ...identity,
      };
    case 'sessionCompleted':
    case 'sessionCanceled':
      if (!isNonNegativeNumber(value.focusedMs)) return null;
      return { t: value.t, at: value.at, focusedMs: value.focusedMs, ...identity };
    case 'phase':
      if (!isPhase(value.from) || !isPhase(value.to)) return null;
      return { t: value.t, at: value.at, from: value.from, to: value.to, ...identity };
    case 'attempt':
      if (
        typeof value.url !== 'string' ||
        typeof value.host !== 'string' ||
        !isNonNegativeInteger(value.tabId) ||
        (value.kind !== 'navigation' && value.kind !== 'existing')
      ) {
        return null;
      }
      return {
        t: value.t,
        at: value.at,
        url: value.url,
        host: value.host,
        tabId: value.tabId,
        kind: value.kind,
        ...identity,
      };
    case 'gateOpened':
    case 'gateResisted':
      if (!isGateKind(value.gate)) return null;
      return { t: value.t, at: value.at, gate: value.gate, ...identity };
    case 'budgetEarned':
    case 'pauseTaken':
      if (!isNonNegativeNumber(value.ms)) return null;
      return { t: value.t, at: value.at, ms: value.ms, ...identity };
    case 'unlockTaken':
      if (typeof value.host !== 'string' || value.host === '' || !isNonNegativeNumber(value.ms)) {
        return null;
      }
      return { t: value.t, at: value.at, host: value.host, ms: value.ms, ...identity };
    default:
      return null;
  }
}

function parseCommitCheckpoint(value: unknown): RuntimeCommitCheckpoint | null {
  if (!isRecord(value) || !isRecord(value.bank) || !Array.isArray(value.events)) return null;
  if (!isNonNegativeNumber(value.bank.balanceMs) || typeof value.syncBank !== 'boolean') {
    return null;
  }
  const events: EventRecord[] = [];
  for (const candidate of value.events) {
    const event: EventRecord | null = parseEventRecord(candidate);
    if (event === null) return null;
    events.push(event);
  }
  return { bank: { balanceMs: value.bank.balanceMs }, events, syncBank: value.syncBank };
}

function parseTabStates(value: unknown): Record<number, RuntimeTabState> {
  if (!isRecord(value)) return {};
  const parsed: Record<number, RuntimeTabState> = {};
  for (const [tabIdText, candidate] of Object.entries(value)) {
    const tabId: number = Number(tabIdText);
    if (!Number.isInteger(tabId) || tabId < 0) continue;
    if (!isRecord(candidate)) continue;
    const state: Record<string, unknown> = candidate;
    const priorMuted: boolean | null =
      state.priorMuted === null || typeof state.priorMuted === 'boolean' ? state.priorMuted : null;
    if (state.priorMuted !== null && typeof state.priorMuted !== 'boolean') continue;

    const legacyUrl: string | null =
      typeof state.url === 'string' && state.url !== '' ? state.url : null;
    const muteUrl: string | null =
      priorMuted === null
        ? null
        : typeof state.muteUrl === 'string' && state.muteUrl !== ''
          ? state.muteUrl
          : legacyUrl;
    if (priorMuted !== null && muteUrl === null) continue;

    const stoppedDocumentId: string | null =
      state.stoppedDocumentId === null || state.stoppedDocumentId === undefined
        ? null
        : typeof state.stoppedDocumentId === 'string' && state.stoppedDocumentId !== ''
          ? state.stoppedDocumentId
          : null;
    if (
      state.stoppedDocumentId !== null &&
      state.stoppedDocumentId !== undefined &&
      stoppedDocumentId === null
    ) {
      continue;
    }
    if (muteUrl === null && stoppedDocumentId === null) continue;
    parsed[tabId] = { muteUrl, priorMuted, stoppedDocumentId };
  }
  return parsed;
}

export async function saveRuntime(r: RuntimeState): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_RUNTIME]: r });
}

export async function loadMatcherCache(): Promise<unknown> {
  return (await chrome.storage.local.get(LOCAL_CACHES))[LOCAL_CACHES];
}

export async function saveMatcherCache(cache: StoredMatcherCache): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_CACHES]: cache });
}

export async function getDeviceId(): Promise<string> {
  const existing: unknown = (await chrome.storage.local.get(LOCAL_DEVICE_ID))[LOCAL_DEVICE_ID];
  if (isNonBlankString(existing)) return existing;
  const id: string = crypto.randomUUID();
  await chrome.storage.local.set({ [LOCAL_DEVICE_ID]: id });
  return id;
}

function parseEventLog(value: unknown): EventRecord[] {
  if (!Array.isArray(value)) return [];
  const events: EventRecord[] = [];
  for (const candidate of value) {
    const event: EventRecord | null = parseEventRecord(candidate);
    if (event !== null) events.push(event);
  }
  return events;
}

export async function appendEvents(evs: EventRecord[]): Promise<void> {
  if (evs.length === 0) return;
  const raw: unknown = (await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS];
  const log: EventRecord[] = parseEventLog(raw);
  const incoming: EventRecord[] = parseEventLog(evs);
  const seen: Set<string> = new Set(log.map((event: EventRecord): string => JSON.stringify(event)));
  const unique: EventRecord[] = [];
  for (const event of incoming) {
    const key: string = JSON.stringify(event);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  const next: EventRecord[] = [...log, ...unique].slice(-EVENT_LOG_CAP);
  await chrome.storage.local.set({ [LOCAL_EVENTS]: next });
}

export async function readEvents(): Promise<EventRecord[]> {
  const raw: unknown = (await chrome.storage.local.get(LOCAL_EVENTS))[LOCAL_EVENTS];
  return parseEventLog(raw);
}
