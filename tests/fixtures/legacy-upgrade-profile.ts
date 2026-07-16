/**
 * The storage a v1 install carries into the v2 worker, modelled on a real profile read on
 * Legacy profile: settings whose gate predates `allowForceEnd`, a direct policy commit that
 * embeds those settings, an unversioned v1 runtime under a v2 schema marker, a v1 event log,
 * Sync mode stuck in publish error behind a blocked aggregate, and twelve remote aggregates.
 *
 * Unit tests and Playwright specs both import this module, so it reaches only into
 * `src/shared` modules that touch nothing browser-specific at import time. Every builder returns
 * fresh objects: a test may mutate what it gets without leaking into the next one.
 */
import { DEFAULT_SETTINGS, rulesFromLists } from '../../src/shared/constants';
import {
  LOCAL_AGGREGATE_TOMBSTONES,
  LOCAL_BANK,
  LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS,
  LOCAL_DEVICE_ID,
  LOCAL_EVENTS,
  LOCAL_INSTALL_MARKER,
  LOCAL_LISTS,
  LOCAL_LISTS_SNAPSHOT,
  LOCAL_POLICY_COMMIT,
  LOCAL_RUNTIME,
  LOCAL_RUNTIME_SCHEMA,
  LOCAL_SETTINGS,
  LOCAL_SETUP,
  LOCAL_STREAK,
  LOCAL_SYNC_JOURNAL,
  SYNC_BANK,
  SYNC_LISTS,
  SYNC_SETTINGS,
  SYNC_STREAK,
  syncAggKey,
} from '../../src/shared/storage-keys';
import type {
  BankState,
  CycleConfig,
  DailyAgg,
  GateState,
  InstallMarker,
  LegacyEventRecord,
  ListsConfig,
  SessionMode,
  SessionRuleSnapshot,
  Settings,
  SetupState,
  SiteUnlock,
  StreakState,
  Strictness,
} from '../../src/shared/types';

/** Anonymised device identity. `getDeviceId` only needs a non-blank string. */
export const LEGACY_UPGRADE_DEVICE_ID: string = '7f0c2a5e-0000-4000-8000-00000000c0de';

/** The gate a v1 writer stored before the force-end bypass existed. */
export interface LegacyUpgradeGateV1 {
  delayMs: number;
  requireTypedPhrase: boolean;
}

/** v1 settings: canonical everywhere except the gate, which never carried `allowForceEnd`. */
export type LegacyUpgradeSettingsV1 = Omit<Settings, 'gate'> & { gate: LegacyUpgradeGateV1 };

/** A v1 session config. `durationMin: null` is the v1 spelling of an until-stopped session. */
export interface LegacyUpgradeSessionConfigV1 {
  mode: SessionMode;
  strictness: Strictness;
  durationMin: number | null;
  cycling: CycleConfig | null;
  intention: string;
  source: 'manual' | 'schedule';
  scheduleEntryId: string | null;
  rules: SessionRuleSnapshot;
}

/** A v1 session as the archived pre-merge worker persisted it, deadlines nullable. */
export interface LegacyUpgradeSessionV1 {
  sessionId: string;
  config: LegacyUpgradeSessionConfigV1;
  startedAt: number;
  sessionEndsAt: number | null;
  phase: 'focus' | 'break' | 'paused';
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  cycleIndex: number;
  pausedFrom: { phase: 'focus' | 'break'; phaseEndsAt: number | null } | null;
  focusedMs: number;
}

/**
 * The eleven keys a v1 worker wrote, in the order it wrote them. The three keys the current
 * `LegacyRuntimeStateV1` adds (`deferredBlockClaims`, `removedTabTombstones`,
 * `scheduleUnavailableNoticeToken`) never existed in this profile.
 */
export interface LegacyUpgradeRuntimeV1 {
  session: LegacyUpgradeSessionV1 | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  tabStates: Record<number, unknown>;
  accruedFocusMs: number;
  attemptDebounce: Record<string, number>;
  scheduleActiveEntryId: string | null;
  date: string;
  todayAgg: DailyAgg | null;
  lastPruneDate: string | null;
  commitCheckpoint: null;
}

/** A v1 `sessionStarted` record for an until-stopped session: `durationMin` is null. */
export interface LegacyUpgradeStartedEventV1 {
  t: 'sessionStarted';
  at: number;
  source: 'manual' | 'schedule';
  mode: SessionMode;
  strictness: Strictness;
  durationMin: null;
  intention: string;
  sessionId: string;
}

export interface LegacyUpgradeProfile {
  local: Record<string, unknown>;
  sync: Record<string, unknown>;
}

const LOCAL_AGGREGATE_DATES: readonly string[] = [
  '2026-09-01',
  '2026-09-02',
  '2026-09-03',
  '2026-09-04',
  '2026-09-05',
  '2026-09-06',
  '2026-09-07',
  '2026-09-08',
  '2026-09-09',
];

const SYNC_AGGREGATE_DATES: readonly string[] = [
  '2026-08-29',
  '2026-08-30',
  '2026-08-31',
  ...LOCAL_AGGREGATE_DATES,
];

/** The aggregate whose publication the profile records as blocked. */
export const LEGACY_UPGRADE_BLOCKED_AGGREGATE_DATE: string = '2026-09-03';

const COMPLETED_SESSION_ID: string = '9b1d4e2a-0000-4000-8000-0000000000a1';
const CANCELED_SESSION_ID: string = '9b1d4e2a-0000-4000-8000-0000000000a2';
const INDEFINITE_SESSION_ID: string = '9b1d4e2a-0000-4000-8000-0000000000a3';

/** Fixed local clock for the captured profile's last session. */
const LAST_SESSION_AT: number = new Date(2026, 8, 9, 9, 0, 0, 0).getTime();

const MINUTE_MS: number = 60_000;

/**
 * Visible customisations sit beside the pre-force-end gate so a parser that silently
 * substituted defaults would show in an assertion, not only the migrated gate.
 */
export function legacyUpgradeSettingsV1(): LegacyUpgradeSettingsV1 {
  const { gate: _canonicalGate, ...rest }: Settings = structuredClone(DEFAULT_SETTINGS);
  return {
    ...rest,
    theme: 'dark',
    presetsMin: [25, 50, 90],
    gate: { delayMs: 10_000, requireTypedPhrase: false },
    schedule: [],
    retentionDays: 60,
  };
}

export function legacyUpgradeLists(): ListsConfig {
  return {
    custom: [
      { kind: 'host', pattern: 'news.ycombinator.com' },
      { kind: 'host', pattern: 'reddit.com' },
    ],
    whitelist: [{ kind: 'host', pattern: 'docs.python.org' }],
    categories: {
      social: true,
      video: true,
      news: false,
      mail: false,
      shopping: false,
      gaming: false,
      forums: false,
    },
    exclusions: { social: ['workplace.com'] },
  };
}

export function legacyUpgradeBank(): BankState {
  return { balanceMs: 123_456 };
}

export function legacyUpgradeStreak(): StreakState {
  return {
    current: 3,
    freezeTokens: 1,
    lastCountedDate: '2026-09-09',
    lastFreezeGrantDate: '2026-09-07',
    activeDays: [7, 8, 9],
    activeMonth: '2026-09',
  };
}

export function legacyUpgradeSetup(): SetupState {
  return {
    version: 1,
    completed: true,
    websiteAccess: 'granted',
    blockingRegistration: 'ready',
    websiteAccessNotice: null,
    storageMode: 'sync',
    syncWriteStatus: 'error',
    storageError: 'sync-publish-failed',
    dataClear: { status: 'idle', scope: null, phase: null },
    legacyImported: true,
  };
}

export function legacyUpgradeInstallMarker(): InstallMarker {
  return { version: 1, profile: 'legacy', latestReason: 'update', extensionVersion: '0.9.0' };
}

/**
 * A daily aggregate in the shape the v1 worker persisted, carrying the two optional counters
 * as zero so it survives normalisation unchanged.
 */
export function legacyUpgradeDailyAgg(date: string): DailyAgg {
  const day: number = Number(date.slice(-2));
  return {
    date,
    focusMs: day * 5 * MINUTE_MS,
    sessionsStarted: 2,
    sessionsCompleted: 1,
    attempts: { 'reddit.com': day, 'news.ycombinator.com': 1 },
    attemptsOther: 0,
    pausesTaken: 1,
    pauseMsSpent: 5 * MINUTE_MS,
    pauseMsEarned: 6 * MINUTE_MS,
    unlocksTaken: 0,
    unlockMsSpent: 0,
    resisted: 1,
  };
}

/** The v1 runtime as the archived worker left it after a session ended: idle, stats retained. */
export function legacyUpgradeRuntimeV1(): LegacyUpgradeRuntimeV1 {
  return {
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    scheduleActiveEntryId: null,
    date: '2026-09-09',
    todayAgg: legacyUpgradeDailyAgg('2026-09-09'),
    lastPruneDate: '2026-09-07',
    commitCheckpoint: null,
  };
}

/** One record per v1 event kind, in the order a session produces them. */
export function legacyUpgradeEventsV1(): LegacyEventRecord[] {
  const at: number = LAST_SESSION_AT;
  return [
    {
      t: 'sessionStarted',
      at,
      source: 'manual',
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: 25,
      intention: 'write the launch post',
      sessionId: COMPLETED_SESSION_ID,
    },
    { t: 'phase', at, from: 'idle', to: 'focus', sessionId: COMPLETED_SESSION_ID },
    {
      t: 'attempt',
      at: at + 2 * MINUTE_MS,
      url: 'https://www.reddit.com/r/programming/',
      host: 'reddit.com',
      tabId: 12,
      kind: 'navigation',
      sessionId: COMPLETED_SESSION_ID,
    },
    { t: 'gateOpened', at: at + 3 * MINUTE_MS, gate: 'pause', sessionId: COMPLETED_SESSION_ID },
    { t: 'gateResisted', at: at + 4 * MINUTE_MS, gate: 'pause', sessionId: COMPLETED_SESSION_ID },
    { t: 'budgetEarned', at: at + 6 * MINUTE_MS, ms: MINUTE_MS, sessionId: COMPLETED_SESSION_ID },
    {
      t: 'pauseTaken',
      at: at + 10 * MINUTE_MS,
      ms: 5 * MINUTE_MS,
      sessionId: COMPLETED_SESSION_ID,
    },
    {
      t: 'unlockTaken',
      at: at + 16 * MINUTE_MS,
      host: 'reddit.com',
      ms: 5 * MINUTE_MS,
      sessionId: COMPLETED_SESSION_ID,
    },
    {
      t: 'sessionCompleted',
      at: at + 25 * MINUTE_MS,
      focusedMs: 25 * MINUTE_MS,
      sessionId: COMPLETED_SESSION_ID,
    },
    {
      t: 'sessionCanceled',
      at: at + 40 * MINUTE_MS,
      focusedMs: 2 * MINUTE_MS,
      sessionId: CANCELED_SESSION_ID,
    },
    {
      t: 'sessionIdentityAssigned',
      at: at + 38 * MINUTE_MS,
      startedAt: at + 38 * MINUTE_MS,
      sessionId: CANCELED_SESSION_ID,
    },
  ];
}

/** The direct policy commit the v1 worker wrote, embedding the pre-force-end settings. */
export function legacyUpgradePolicyCommit(): { source: 'direct'; revision: string } {
  const snapshot: Record<string, unknown> = {
    settings: legacyUpgradeSettingsV1(),
    lists: legacyUpgradeLists(),
    bank: legacyUpgradeBank(),
    streak: legacyUpgradeStreak(),
  };
  return { source: 'direct', revision: `policy-v1:${JSON.stringify(snapshot)}` };
}

function aggregateItems(dates: readonly string[]): Record<string, DailyAgg> {
  const items: Record<string, DailyAgg> = {};
  for (const date of dates) {
    items[syncAggKey(LEGACY_UPGRADE_DEVICE_ID, date)] = legacyUpgradeDailyAgg(date);
  }
  return items;
}

/**
 * Both storage areas of the profile. `caches` is omitted on purpose: its absence is valid and
 * the matcher cache rebuilds from the lists.
 */
export function legacyUpgradeProfile(): LegacyUpgradeProfile {
  const blockedKey: string = syncAggKey(
    LEGACY_UPGRADE_DEVICE_ID,
    LEGACY_UPGRADE_BLOCKED_AGGREGATE_DATE,
  );
  const local: Record<string, unknown> = {
    [LOCAL_SETTINGS]: legacyUpgradeSettingsV1(),
    [LOCAL_LISTS]: legacyUpgradeLists(),
    [LOCAL_BANK]: legacyUpgradeBank(),
    [LOCAL_STREAK]: legacyUpgradeStreak(),
    [LOCAL_POLICY_COMMIT]: legacyUpgradePolicyCommit(),
    [LOCAL_RUNTIME]: legacyUpgradeRuntimeV1(),
    [LOCAL_RUNTIME_SCHEMA]: { runtimeSchemaVersion: 2 },
    [LOCAL_EVENTS]: legacyUpgradeEventsV1(),
    [LOCAL_SETUP]: legacyUpgradeSetup(),
    [LOCAL_INSTALL_MARKER]: legacyUpgradeInstallMarker(),
    ...aggregateItems(LOCAL_AGGREGATE_DATES),
    [LOCAL_LISTS_SNAPSHOT]: legacyUpgradeLists(),
    [LOCAL_SYNC_JOURNAL]: { sets: {}, removes: [] },
    [LOCAL_BLOCKED_AGGREGATE_PUBLICATIONS]: {
      version: 1,
      items: { [blockedKey]: legacyUpgradeDailyAgg(LEGACY_UPGRADE_BLOCKED_AGGREGATE_DATE) },
    },
    [LOCAL_AGGREGATE_TOMBSTONES]: [],
    [LOCAL_DEVICE_ID]: LEGACY_UPGRADE_DEVICE_ID,
  };
  const sync: Record<string, unknown> = {
    [SYNC_SETTINGS]: legacyUpgradeSettingsV1(),
    [SYNC_LISTS]: legacyUpgradeLists(),
    [SYNC_BANK]: legacyUpgradeBank(),
    [SYNC_STREAK]: legacyUpgradeStreak(),
    ...aggregateItems(SYNC_AGGREGATE_DATES),
  };
  return { local, sync };
}

/** A v1 until-stopped Friction session in focus: null duration, null deadlines. */
export function legacyIndefiniteSessionV1(startedAt: number): LegacyUpgradeSessionV1 {
  return {
    sessionId: INDEFINITE_SESSION_ID,
    config: {
      mode: 'blacklist',
      strictness: 'friction',
      durationMin: null,
      cycling: null,
      intention: 'write the launch post',
      source: 'manual',
      scheduleEntryId: null,
      rules: rulesFromLists(legacyUpgradeLists()),
    },
    startedAt,
    sessionEndsAt: null,
    phase: 'focus',
    phaseStartedAt: startedAt,
    phaseEndsAt: null,
    cycleIndex: 0,
    pausedFrom: null,
    focusedMs: 0,
  };
}

/** The cancel gate a v1 worker opened on that session, with the force-end escape minted. */
export function legacyIndefiniteCancelGateV1(openedAt: number): GateState {
  return {
    kind: 'cancel',
    host: null,
    openedAt,
    readyAt: openedAt + 10_000,
    requiredPhrase: null,
    forceEndAvailable: true,
  };
}

/** The v1 start record of an until-stopped session: the archived worker wrote `durationMin` null. */
export function legacyIndefiniteStartedEventV1(at: number): LegacyUpgradeStartedEventV1 {
  return {
    t: 'sessionStarted',
    at,
    source: 'manual',
    mode: 'blacklist',
    strictness: 'friction',
    durationMin: null,
    intention: 'write the launch post',
    sessionId: INDEFINITE_SESSION_ID,
  };
}
