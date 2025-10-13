import type {
  BankState,
  CycleConfig,
  DailyAgg,
  GateState,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  ScheduleOccurrenceRef,
  SessionEndedEventV2,
  SessionEndReasonV2,
  SessionMode,
  SessionOutcomeV2,
  SessionRuleSnapshot,
  SessionStartedEventV2,
  SessionStateV2,
  SiteUnlock,
  Strictness,
} from '../shared/types';
import type {
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  FrozenDocumentCommand,
} from './enforcement-persistence-v2';
import type { DeferredBlockClaim, RuntimeTabState } from './runtime-leaf-types';

export type TransitionFailureReason =
  | 'website-access-lost'
  | 'content-registration-failed'
  | 'alarm-failed'
  | 'tab-enforcement-failed';

export type StartDurationPlan =
  | { kind: 'manual-timed'; minutes: number }
  | { kind: 'schedule-window' }
  | { kind: 'until-stopped' };

export interface CandidateScheduleWindow {
  windowStartsAt: number;
  windowEndsAt: number;
}

export interface SessionStartCandidate {
  mode: SessionMode;
  strictness: Strictness;
  duration: StartDurationPlan;
  cycling: CycleConfig | null;
  intention: string;
  source: 'manual' | 'schedule';
  scheduleOccurrence: ScheduleOccurrenceRef | null;
  scheduleWindow: CandidateScheduleWindow | null;
  rules: SessionRuleSnapshot;
}

export interface CleanupRetryState {
  batch: number;
  automaticAttempt: number;
  nextAttemptAt: number | null;
  lastError: string | null;
}

export interface CleanupTabClaim {
  tabId: number;
  state: RuntimeTabState;
}

export interface CleanupSeed {
  alarmNames: string[];
  tabClaims: CleanupTabClaim[];
}

export interface CleanupEnforcementTarget {
  tabId: number;
  documentId: string;
  expectedUrl: string;
}

export interface CleanupProgress {
  cleanupOperationId: string;
  clearRuntimeRevision: number;
  targets: Record<string, CleanupEnforcementTarget>;
  clearCommands: Record<string, FrozenDocumentCommand>;
  tabClaims: CleanupTabClaim[];
  resolvedTabIds: number[];
  retry: CleanupRetryState;
}

export interface PostCleanupClosure {
  projection: ClosureProjection;
  cleanupSeed: CleanupSeed;
}

export interface FrozenTransitionView {
  capturedAt: number;
  operationId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  runtimeRevision: number;
  documents: Record<string, FrozenDocumentCommand>;
}

export interface PreparedTargetReservation {
  tabId: number;
  documentId: string;
  expectedUrl: string;
  commandKey: string;
}

export type TransitionStage =
  | 'prepared'
  | 'registration-audited'
  | 'starting-verified'
  | 'committed-pending-verification'
  | 'alarm-ready'
  | 'active-verified'
  | 'cleanup';

export interface PendingEnforcementTransition {
  version: 1;
  kind: 'start' | 'resume';
  stage: TransitionStage;
  transitionId: string;
  startingOperationId: string;
  activeOperationId: string;
  enforcementEpoch: string;
  basePolicyRevision: number;
  runtimeRevision: number;
  sessionId: string;
  trigger: 'manual' | 'schedule' | 'pause-expired' | 'break-expired';
  requestedAt: number;
  candidate: SessionStartCandidate | null;
  priorPhase: 'paused' | 'break' | null;
  activationAt: number | null;
  verificationStartedAt: number | null;
  freshnessAttempts: number;
  targetGeneration: number;
  preparedTargetReservations: Record<string, PreparedTargetReservation>;
  startingView: FrozenTransitionView;
  activeView: FrozenTransitionView | null;
  startingCheckpoint: EnforcementCheckpoint | null;
  checkpoint: EnforcementCheckpoint | null;
  alarmNames: string[];
  failure: TransitionFailureReason | null;
  cleanupProgress: CleanupProgress | null;
  cleanupFrom:
    | 'prepared'
    | 'registration-audited'
    | 'starting-verified'
    | 'committed-pending-verification'
    | 'alarm-ready'
    | 'active-verified'
    | null;
  cleanupCause:
    | 'start-abandon'
    | 'resume-restore'
    | 'timer-completed'
    | 'manual-end'
    | 'transition-failed'
    | null;
  postCleanupClosure: PostCleanupClosure | null;
}

export interface ClosureProjection {
  closureId: string;
  sessionId: string;
  endedAt: number;
  reason: SessionEndReasonV2;
  outcome: SessionOutcomeV2;
  focusedMs: number;
  endEvent: SessionEndedEventV2;
  events: Array<LegacyEventRecord | SessionEndedEventV2>;
  handledOccurrences: HandledScheduleOccurrence[];
  completionIncrement: 0 | 1;
  bankAfter: BankState;
  aggregateSets: Record<string, DailyAgg>;
  aggregateRemoves: string[];
}

export type PendingClosure =
  | {
      version: 1;
      stage: 'prepared';
      projection: ClosureProjection;
      cleanupSeed: CleanupSeed;
      cleanupProgress: null;
    }
  | {
      version: 1;
      stage: 'cleanup';
      projection: ClosureProjection;
      cleanupSeed: CleanupSeed;
      cleanupProgress: CleanupProgress;
    };

export interface RuntimeDomainProjectionV2 {
  session: SessionStateV2 | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  accruedFocusMs: number;
  handledScheduleOccurrences: HandledScheduleOccurrence[];
  enforcementEpoch: string;
  epochResetAcks: Record<string, DocumentEpochResetAck>;
  basePolicyRevision: number;
  runtimeRevision: number;
  documentCommands: Record<string, FrozenDocumentCommand>;
  enforcementCheckpoint: EnforcementCheckpoint | null;
  pendingEnforcementTransition: PendingEnforcementTransition | null;
  pendingClosure: PendingClosure | null;
}

export interface RuntimeCommitCheckpointV2 {
  version: 2;
  checkpointId: string;
  projection: RuntimeDomainProjectionV2;
  bank: BankState;
  events: Array<LegacyEventRecord | SessionStartedEventV2 | SessionEndedEventV2>;
  syncBank: boolean;
  aggregateSets: Record<string, DailyAgg>;
  aggregateRemoves: string[];
}

/** The audit record of the one focus credit a v1 to v2 migration applies, settled once. */
export interface LegacyMigrationFocusSettlement {
  settledAt: number;
  settledThrough: number;
  phaseAtMigration: 'focus' | 'break' | 'paused';
  focusedMsBefore: number;
  creditedFocusMs: number;
  focusedMsAfter: number;
}

/** The closure an invalid v1 active state migrates into, captured before the checkpoint write. */
export interface MigrationCleanupPlan {
  version: 1;
  settlement: LegacyMigrationFocusSettlement;
  projection: ClosureProjection;
  cleanupSeed: CleanupSeed;
  cleanupProgress: CleanupProgress;
}

/**
 * The one durable record of a v1 to v2 migration. The checkpoint and its marker are stored in the
 * same local runtime generation and validated as one value, so a marker never outlives the
 * checkpoint that explains it.
 */
export interface RuntimeMigrationCheckpointV1ToV2 {
  version: 1;
  fromRuntimeSchemaVersion: 1;
  toRuntimeSchemaVersion: 2;
  migratedAt: number;
  assignedSessionId: string | null;
  identityEvent: Extract<LegacyEventRecord, { t: 'sessionIdentityAssigned' }> | null;
  projectedRuntime: RuntimeStateV2;
  cleanupPlan: MigrationCleanupPlan | null;
  marker: { runtimeSchemaVersion: 2 };
}

export interface RuntimeStateV2 {
  runtimeSchemaVersion: 2;
  session: SessionStateV2 | null;
  gate: GateState | null;
  unlocks: SiteUnlock[];
  tabStates: Record<number, RuntimeTabState>;
  accruedFocusMs: number;
  attemptDebounce: Record<string, number>;
  deferredBlockClaims: Record<string, DeferredBlockClaim>;
  removedTabTombstones: Record<number, true>;
  scheduleUnavailableNoticeToken: string | null;
  handledScheduleOccurrences: HandledScheduleOccurrence[];
  enforcementEpoch: string;
  epochResetAcks: Record<string, DocumentEpochResetAck>;
  basePolicyRevision: number;
  runtimeRevision: number;
  documentCommands: Record<string, FrozenDocumentCommand>;
  enforcementCheckpoint: EnforcementCheckpoint | null;
  pendingEnforcementTransition: PendingEnforcementTransition | null;
  pendingClosure: PendingClosure | null;
  date: string;
  todayAgg: DailyAgg | null;
  lastPruneDate: string | null;
  commitCheckpoint: RuntimeCommitCheckpointV2 | null;
}
