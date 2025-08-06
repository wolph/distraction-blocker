export type RuleKind = 'host' | 'regex';

export interface Rule {
  kind: RuleKind;
  /** hostname for kind host (matches the host and all subdomains), regex source for kind regex (matches the full URL) */
  pattern: string;
}

export type CategoryId = 'social' | 'video' | 'news' | 'mail' | 'shopping' | 'gaming' | 'forums';

export interface CategoryList {
  id: CategoryId;
  title: string;
  hosts: string[];
}

export interface ListsConfig {
  custom: Rule[];
  whitelist: Rule[];
  categories: Record<CategoryId, boolean>;
  /** per category: host entries the user excluded (the facebook-for-work case) */
  exclusions: Partial<Record<CategoryId, string[]>>;
}

export type HostRule = { kind: 'host'; pattern: string };

export interface SessionRuleSnapshot {
  baselineRevision: string;
  /** Authoritative category defaults at baselineRevision. The worker verifies these. */
  baselineCategories: Record<CategoryId, boolean>;
  /** Effective categories for this session. Differences from baselineCategories are session-only. */
  categories: Record<CategoryId, boolean>;
  exclusions: Partial<Record<CategoryId, string[]>>;
  permanentBlacklist: Rule[];
  permanentAllowlist: Rule[];
  sessionBlacklist: HostRule[];
  sessionAllowlist: HostRule[];
}

export type SessionMode = 'blacklist' | 'whitelist';
export type Strictness = 'flexible' | 'friction' | 'hard';
export type StorageMode = 'local' | 'sync';
export type BlockingRegistrationStatus = 'unavailable' | 'ready' | 'error';
export type ThemeMode = 'auto' | 'light' | 'dark';
export type Phase = 'idle' | 'focus' | 'break' | 'paused';

export interface SetupState {
  version: 1;
  completed: boolean;
  websiteAccess: 'pending' | 'granted' | 'denied';
  blockingRegistration: BlockingRegistrationStatus;
  websiteAccessNotice: 'revoked-during-session' | 'registration-failed-during-session' | null;
  storageMode: StorageMode | null;
  syncWriteStatus: 'idle' | 'pending' | 'error';
  storageError:
    | 'legacy-migration-failed'
    | 'sync-publish-failed'
    | 'remote-deletion-failed'
    | 'local-clear-failed'
    | null;
  dataClear:
    | { status: 'idle'; scope: null; phase: null }
    | {
        status: 'pending' | 'error';
        scope: 'synced-policy' | 'all';
        phase: 'remote' | 'local';
      }
    | {
        status: 'pending' | 'error';
        scope: 'local-history';
        phase: 'local' | 'runtime';
      };
  legacyImported: boolean;
}

export type OnboardingStep = 1 | 2 | 3;
export type WebsiteAccessChoice =
  | 'pending'
  | 'granted'
  | 'denied'
  | 'deferred'
  | 'registration-error';

export interface OnboardingDraft {
  version: 1;
  /** Worker-issued optimistic concurrency token. New, unsaved drafts use 0. */
  revision: number;
  step: OnboardingStep;
  settings: Settings;
  lists: ListsConfig;
  websiteAccessChoice: WebsiteAccessChoice;
  syncEnabled: boolean;
}

export interface InstallMarker {
  version: 1;
  profile: 'clean' | 'legacy';
  latestReason: 'install' | 'update';
  extensionVersion: string;
}

export interface CycleConfig {
  focusMin: number;
  shortBreakMin: number;
  longBreakMin: number;
  /** every Nth break is a long one */
  longEvery: number;
}

export interface NormalizedSessionConfigV1 {
  mode: SessionMode;
  strictness: Strictness;
  /** total session length in minutes, fractional allowed (tests use 0.1) */
  durationMin: number;
  cycling: CycleConfig | null;
  intention: string;
  source: 'manual' | 'schedule';
  scheduleEntryId: string | null;
  rules: SessionRuleSnapshot;
}

export type SessionConfig = NormalizedSessionConfigV1;

/** Persisted machine state. Pure functions in src/core/session.ts own all transitions. */
export interface NormalizedSessionStateV1 {
  /** Stable identity for this session. Missing only on legacy persisted state. */
  sessionId?: string;
  config: NormalizedSessionConfigV1;
  startedAt: number;
  sessionEndsAt: number;
  phase: 'focus' | 'break' | 'paused';
  phaseStartedAt: number;
  phaseEndsAt: number;
  /** 0-based index of the current focus cycle */
  cycleIndex: number;
  /** set while paused: what to restore on resume */
  pausedFrom: { phase: 'focus' | 'break'; phaseEndsAt: number } | null;
  /** focus ms completed so far, maintained by advance(), excludes breaks and pauses */
  focusedMs: number;
}

export type SessionState = NormalizedSessionStateV1;

export type PredecessorSessionRuleSnapshotV1 = Omit<SessionRuleSnapshot, 'baselineCategories'>;

export type PersistedLegacySessionConfigV1 = Omit<NormalizedSessionConfigV1, 'rules'> & {
  rules?: SessionRuleSnapshot | PredecessorSessionRuleSnapshotV1;
};

export type PersistedLegacySessionStateV1 = Omit<NormalizedSessionStateV1, 'config'> & {
  config: PersistedLegacySessionConfigV1;
};

export type LocalDate = string;

export interface ScheduleOccurrenceRef {
  version: 1;
  token: string;
  entryId: string;
  localStartDate: LocalDate;
}

export interface HandledScheduleOccurrence {
  version: 1;
  token: string;
  entryId: string;
  localStartDate: LocalDate;
  handledAt: number;
  reason: 'started' | 'closure-overlap';
  expiresAt: number;
}

export type SessionDuration = { kind: 'timed'; minutes: number } | { kind: 'until-stopped' };

export type ScheduleDuration = { kind: 'window' } | { kind: 'until-stopped' };

export interface SessionConfigV2 {
  mode: SessionMode;
  strictness: Strictness;
  duration: SessionDuration;
  cycling: CycleConfig | null;
  intention: string;
  source: 'manual' | 'schedule';
  scheduleOccurrence: ScheduleOccurrenceRef | null;
  rules: SessionRuleSnapshot;
}

export interface PausedFromStateV2 {
  phase: 'focus' | 'break';
  phaseEndsAt: number | null;
}

export interface SessionStateV2 {
  version: 2;
  sessionId: string;
  config: SessionConfigV2;
  startedAt: number;
  sessionEndsAt: number | null;
  phase: 'focus' | 'break' | 'paused';
  phaseStartedAt: number;
  phaseEndsAt: number | null;
  cycleIndex: number;
  pausedFrom: PausedFromStateV2 | null;
  focusedMs: number;
}

export interface ScheduleEntryV2 {
  id: string;
  days: number[];
  start: string;
  end: string;
  duration: ScheduleDuration;
  mode: SessionMode;
  strictness: Strictness;
  cycling: CycleConfig | null;
  intention: string;
  enabled: boolean;
}

export type SettingsV2 = Omit<Settings, 'schedule'> & { schedule: ScheduleEntryV2[] };

export type GateKind = 'pause' | 'unlockSite' | 'cancel';

export interface GateState {
  kind: GateKind;
  /** registrable domain being unlocked when kind is unlockSite */
  host: string | null;
  openedAt: number;
  readyAt: number;
  /** exact phrase the user must type, null when typing is not required */
  requiredPhrase: string | null;
}

export interface SiteUnlock {
  host: string;
  until: number;
}

/** Read model broadcast to every UI surface. The worker is the only writer. */
export interface NormalizedSessionSnapshotV1 {
  at: number;
  theme: ThemeMode;
  phase: Phase;
  config: NormalizedSessionConfigV1 | null;
  startedAt: number | null;
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  sessionEndsAt: number | null;
  cycleIndex: number;
  bankMs: number;
  /** pause ms earned per elapsed ms at snapshot time, 0 outside focus */
  bankAccrualPerMs: number;
  bankCapMs: number;
  /** current costs of the two spends, so UIs can render affordability countdowns */
  pauseCostMs: number;
  unlockCostMs: number;
  activeUnlocks: SiteUnlock[];
  gate: GateState | null;
  attemptsToday: number;
  scheduleActive: boolean;
  nextSchedule: { entryId: string; startsAt: number } | null;
}

export type SessionSnapshot = NormalizedSessionSnapshotV1;

export type EndAuthorityV2 =
  | { kind: 'hidden' }
  | { kind: 'immediate'; actionLabel: 'End session' }
  | {
      kind: 'friction-gate';
      gate: null;
      copy: { actionLabel: 'End session' };
      actions: { open: 'open-end-gate' };
    }
  | {
      kind: 'friction-gate';
      gate: GateState & { kind: 'cancel' };
      copy: {
        title: 'End this session';
        back: 'Never mind, back to work';
        phraseLabel: 'Type this to confirm:';
        confirm: 'End the session';
        intentionReminder: string | null;
      };
      actions: {
        abandon: 'abandon-gate';
        confirm: 'confirm-gate';
      };
    };

export type SessionLifecycleV2 =
  | { kind: 'idle'; endAuthority: { kind: 'hidden' } }
  | {
      kind: 'starting';
      operationId: string;
      transition: 'start' | 'resume';
      endAuthority: EndAuthorityV2;
    }
  | {
      kind: 'cleanup';
      journal: 'transition' | 'closure';
      id: string;
      endAuthority: { kind: 'hidden' };
    }
  | { kind: 'active'; endAuthority: EndAuthorityV2 }
  | {
      kind: 'error';
      code: 'transition-cleanup-failed' | 'closure-cleanup-failed';
      retryAvailable: true;
      endAuthority: { kind: 'hidden' };
    };

export interface SessionSnapshotV2 {
  at: number;
  theme: ThemeMode;
  lifecycle: SessionLifecycleV2;
  phase: Phase;
  config: SessionConfigV2 | null;
  startedAt: number | null;
  phaseStartedAt: number | null;
  phaseEndsAt: number | null;
  sessionEndsAt: number | null;
  sessionFocusedMs: number;
  cycleIndex: number;
  bankMs: number;
  bankAccrualPerMs: number;
  bankCapMs: number;
  pauseCostMs: number;
  unlockCostMs: number;
  activeUnlocks: SiteUnlock[];
  gate: GateState | null;
  attemptsToday: number;
  scheduleActive: boolean;
  nextSchedule: { entryId: string; startsAt: number } | null;
}

export interface PauseEconomy {
  /** pause ms earned per focus ms, default 5/30 */
  earnRatio: number;
  capMs: number;
  /** length and cost of a full pause */
  pauseMs: number;
  /** length and cost of a single-site unlock */
  unlockMs: number;
}

export interface GateSettings {
  delayMs: number;
  requireTypedPhrase: boolean;
}

export interface SoundSettings {
  masterVolume: number;
  sessionComplete: boolean;
  breakStart: boolean;
  breakEnd: boolean;
  scheduleStart: boolean;
}

export interface NormalizedScheduleEntryV1 {
  id: string;
  /** 0 = Sunday through 6 = Saturday, Date.getDay convention */
  days: number[];
  /** "HH:MM" local wall clock, start must be earlier than end on the same day */
  start: string;
  end: string;
  mode: SessionMode;
  strictness: Strictness;
  cycling: CycleConfig | null;
  intention: string;
  enabled: boolean;
}

export type ScheduleEntry = NormalizedScheduleEntryV1;

export interface Settings {
  theme: ThemeMode;
  presetsMin: [number, number, number];
  defaultMode: SessionMode;
  defaultStrictness: Strictness;
  defaultCycling: CycleConfig;
  cyclingOnByDefault: boolean;
  pause: PauseEconomy;
  gate: GateSettings;
  badgeCountdown: boolean;
  sessionCompleteNotification: boolean;
  sounds: SoundSettings;
  schedule: ScheduleEntry[];
  streakGoalMin: number;
  streakFreezeIntervalDays: number;
  retentionDays: number;
}

export interface BankState {
  balanceMs: number;
}

export interface DailyAgg {
  /** YYYY-MM-DD local */
  date: string;
  focusMs: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  /** blocked attempts per registrable domain */
  attempts: Record<string, number>;
  attemptsOther: number;
  pausesTaken: number;
  pauseMsSpent: number;
  /** Exact bank credit recorded when focus intervals settle. Missing on legacy data. */
  pauseMsEarned?: number;
  unlocksTaken: number;
  /** Exact unlock budget spent. Missing on legacy data. */
  unlockMsSpent?: number;
  /** deliberation gates opened and then abandoned, the win metric */
  resisted: number;
}

export interface MonthlyAgg {
  /** YYYY-MM local */
  month: string;
  focusMs: number;
  sessionsStarted: number;
  sessionsCompleted: number;
  attempts: Record<string, number>;
  attemptsOther: number;
  pausesTaken: number;
  pauseMsSpent: number;
  pauseMsEarned?: number;
  unlocksTaken: number;
  unlockMsSpent?: number;
  resisted: number;
}

export interface StreakState {
  current: number;
  /** banked freeze tokens, max 2, one granted per Monday */
  freezeTokens: number;
  lastCountedDate: string | null;
  lastFreezeGrantDate: string | null;
  /** day numbers of activeMonth that met the goal */
  activeDays: number[];
  activeMonth: string;
}

export type LegacyEventRecord =
  | {
      t: 'sessionStarted';
      at: number;
      source: 'manual' | 'schedule';
      mode: SessionMode;
      strictness: Strictness;
      durationMin: number;
      intention: string;
      sessionId?: string;
    }
  | { t: 'sessionCompleted'; at: number; focusedMs: number; sessionId?: string }
  | { t: 'sessionCanceled'; at: number; focusedMs: number; sessionId?: string }
  | { t: 'sessionIdentityAssigned'; at: number; startedAt: number; sessionId: string }
  | { t: 'phase'; at: number; from: Phase; to: Phase; sessionId?: string }
  | {
      t: 'attempt';
      at: number;
      url: string;
      host: string;
      tabId: number;
      kind: 'navigation' | 'existing';
      sessionId?: string;
    }
  | { t: 'gateOpened'; at: number; gate: GateKind; sessionId?: string }
  | { t: 'gateResisted'; at: number; gate: GateKind; sessionId?: string }
  | { t: 'budgetEarned'; at: number; ms: number; sessionId?: string }
  | { t: 'pauseTaken'; at: number; ms: number; sessionId?: string }
  | { t: 'unlockTaken'; at: number; host: string; ms: number; sessionId?: string };

export type EventRecord = LegacyEventRecord;

export type SessionEndReasonV2 =
  | 'timer-completed'
  | 'manual-completed'
  | 'manual-canceled'
  | 'website-access-lost'
  | 'content-registration-failed'
  | 'alarm-failed'
  | 'tab-enforcement-failed'
  | 'invalid-active-state';

export type SessionOutcomeV2 = 'completed' | 'canceled';

export interface SessionStartedEventV2 {
  version: 2;
  t: 'sessionStarted';
  eventId: string;
  at: number;
  sessionId: string;
  source: 'manual' | 'schedule';
  mode: SessionMode;
  strictness: Strictness;
  duration: SessionDuration;
  intention: string;
  scheduleOccurrence: ScheduleOccurrenceRef | null;
}

export interface SessionEndedEventV2 {
  version: 2;
  t: 'sessionEnded';
  eventId: string;
  at: number;
  sessionId: string;
  outcome: SessionOutcomeV2;
  reason: SessionEndReasonV2;
  focusedMs: number;
  duration: SessionDuration;
  source: 'manual' | 'schedule';
  scheduleOccurrence: ScheduleOccurrenceRef | null;
}

export type SessionEventRecordV2 = LegacyEventRecord | SessionStartedEventV2 | SessionEndedEventV2;

export interface Verdict {
  blocked: boolean;
  reason:
    | 'no-session'
    | 'always-allow'
    | 'unlock'
    | 'excluded'
    | 'category'
    | 'custom'
    | 'whitelist'
    | 'whitelist-miss'
    | 'default';
  categoryId: CategoryId | null;
  matchedPattern: string | null;
}
