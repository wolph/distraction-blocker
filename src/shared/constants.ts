import { normalizeHost } from './host-normalization';
import type {
  CategoryId,
  ListsConfig,
  Rule,
  SessionRuleSnapshot,
  SessionSnapshot,
  SessionSnapshotV2,
  Settings,
  SetupState,
} from './types';

export const CATEGORY_IDS: readonly CategoryId[] = [
  'social',
  'video',
  'news',
  'mail',
  'shopping',
  'gaming',
  'forums',
];

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  presetsMin: [15, 25, 50],
  defaultMode: 'blacklist',
  defaultStrictness: 'friction',
  defaultCycling: { focusMin: 25, shortBreakMin: 5, longBreakMin: 15, longEvery: 4 },
  cyclingOnByDefault: true,
  pause: {
    earnRatio: 5 / 30,
    capMs: 30 * 60_000,
    pauseMs: 5 * 60_000,
    unlockMs: 5 * 60_000,
  },
  gate: { delayMs: 10_000, requireTypedPhrase: false },
  badgeCountdown: true,
  sessionCompleteNotification: true,
  sounds: {
    masterVolume: 0.6,
    sessionComplete: true,
    breakStart: true,
    breakEnd: true,
    scheduleStart: true,
  },
  schedule: [],
  streakGoalMin: 25,
  streakFreezeIntervalDays: 7,
  retentionDays: 90,
};

export const DEFAULT_LISTS: ListsConfig = {
  custom: [],
  whitelist: [],
  categories: {
    social: false,
    video: false,
    news: false,
    mail: false,
    shopping: false,
    gaming: false,
    forums: false,
  },
  exclusions: {},
};

export const DEFAULT_SETUP: SetupState = {
  version: 1,
  completed: false,
  websiteAccess: 'pending',
  blockingRegistration: 'unavailable',
  websiteAccessNotice: null,
  storageMode: null,
  syncWriteStatus: 'idle',
  storageError: null,
  dataClear: { status: 'idle', scope: null, phase: null },
  legacyImported: false,
};

function canonicalRule(rule: Rule): Rule {
  return {
    kind: rule.kind,
    pattern: rule.kind === 'host' ? canonicalHost(rule.pattern) : rule.pattern,
  };
}

function canonicalHost(host: string): string {
  return normalizeHost(host) ?? host.trim().toLowerCase();
}

function canonicalRules(rules: Rule[]): Rule[] {
  const keyed: Map<string, Rule> = new Map<string, Rule>();
  for (const rule of rules) {
    const canonical: Rule = canonicalRule(rule);
    keyed.set(`${canonical.kind}\u0000${canonical.pattern}`, canonical);
  }
  return [...keyed.entries()]
    .sort(([left]: [string, Rule], [right]: [string, Rule]): number =>
      left < right ? -1 : left > right ? 1 : 0,
    )
    .map(([, rule]: [string, Rule]): Rule => rule);
}

function canonicalHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map(canonicalHost))].sort();
}

function canonicalPolicy(lists: ListsConfig): unknown {
  const categories: Array<[CategoryId, boolean]> = CATEGORY_IDS.map(
    (id: CategoryId): [CategoryId, boolean] => [id, lists.categories[id]],
  );
  const exclusions: Array<[CategoryId, string[]]> = CATEGORY_IDS.flatMap(
    (id: CategoryId): Array<[CategoryId, string[]]> => {
      const hosts: string[] | undefined = lists.exclusions[id];
      if (hosts === undefined) return [];
      const canonical: string[] = canonicalHosts(hosts);
      return canonical.length === 0 ? [] : [[id, canonical]];
    },
  );
  return {
    categories,
    exclusions,
    custom: canonicalRules(lists.custom),
    whitelist: canonicalRules(lists.whitelist),
  };
}

/** Deterministic freshness token for list policy. This is not a security hash. */
export function policyRevision(lists: ListsConfig): string {
  const canonical: string = JSON.stringify(canonicalPolicy(lists));
  return `lists-v1:${canonical}`;
}

export function rulesFromLists(lists: ListsConfig): SessionRuleSnapshot {
  return {
    baselineRevision: policyRevision(lists),
    baselineCategories: { ...lists.categories },
    categories: { ...lists.categories },
    exclusions: structuredClone(lists.exclusions),
    permanentBlacklist: structuredClone(lists.custom),
    permanentAllowlist: structuredClone(lists.whitelist),
    sessionBlacklist: [],
    sessionAllowlist: [],
  };
}

export const ALWAYS_ALLOW_SCHEMES: readonly string[] = [
  'chrome:',
  'chrome-extension:',
  'about:',
  'edge:',
  'devtools:',
  'file:',
];

export const ALWAYS_ALLOW_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];

export const ALWAYS_ALLOW_HOST_SUFFIXES: readonly string[] = ['.localhost', '.local', '.test'];

export const GATE_EXPIRY_MS: number = 60_000;
export const MIN_BREAK_BEFORE_EARLY_MS: number = 2 * 60_000;
export const ATTEMPT_DEBOUNCE_MS: number = 30_000;
export const EVENT_LOG_CAP: number = 50_000;
export const TOP_SITES_DAILY: number = 20;
export const TOP_SITES_MONTHLY: number = 10;
export const MAX_FREEZE_TOKENS: number = 2;
export const RUNTIME_SCHEMA_VERSION_V2: 2 = 2;
/** The spec's 12-attempt cleanup schedule: one batch makes at most this many automatic attempts. */
export const CLEANUP_MAX_AUTOMATIC_ATTEMPTS: number = 12;
/**
 * The bounded freshness budget a committed transition spends verifying its active view. The runner
 * spends it and the stored-transition matrix bounds it, so the two read one definition.
 */
export const MAX_FINAL_FRESHNESS_ATTEMPTS: number = 3;
export const HANDLED_SCHEDULE_OCCURRENCE_RETENTION_MS: number = 14 * 24 * 60 * 60 * 1_000;
export const MAX_HANDLED_SCHEDULE_OCCURRENCES: number = 256;

export function cancelPhrase(intention: string): string {
  const goal: string = intention.trim();
  if (goal === '') return 'I am ending this focus session early';
  return `I am ending this session before: ${goal}`;
}

export function pausePhrase(): string {
  return 'I am pausing blocking';
}

export function unlockSitePhrase(host: string): string {
  return `I am allowing this site: ${host}`;
}

/** The idle read model every consumer starts from. One shape, which is the v2 one. */
export function emptySnapshot(at: number): SessionSnapshot {
  return emptySnapshotV2(at);
}

export function emptySnapshotV2(at: number): SessionSnapshotV2 {
  return {
    at,
    theme: DEFAULT_SETTINGS.theme,
    lifecycle: { kind: 'idle', endAuthority: { kind: 'hidden' } },
    phase: 'idle',
    config: null,
    startedAt: null,
    phaseStartedAt: null,
    phaseEndsAt: null,
    sessionEndsAt: null,
    sessionFocusedMs: 0,
    cycleIndex: 0,
    bankMs: 0,
    bankAccrualPerMs: 0,
    bankCapMs: DEFAULT_SETTINGS.pause.capMs,
    pauseCostMs: DEFAULT_SETTINGS.pause.pauseMs,
    unlockCostMs: DEFAULT_SETTINGS.pause.unlockMs,
    activeUnlocks: [],
    gate: null,
    attemptsToday: 0,
    scheduleActive: false,
    nextSchedule: null,
  };
}
