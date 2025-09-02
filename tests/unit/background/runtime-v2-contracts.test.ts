import { describe, expectTypeOf, it } from 'vitest';
import type {
  DocumentEpochResetAck,
  EnforcementCheckpoint,
  FrozenDocumentCommand,
} from '../../../src/background/enforcement-persistence-v2';
import type {
  DeferredBlockClaim,
  RuntimeTabState,
} from '../../../src/background/runtime-leaf-types';
import type {
  CandidateScheduleWindow,
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  FrozenTransitionView,
  PendingClosure,
  PendingEnforcementTransition,
  PostCleanupClosure,
  PreparedTargetReservation,
  RuntimeCommitCheckpointV2,
  RuntimeDomainProjectionV2,
  RuntimeStateV2,
  SessionStartCandidate,
  StartDurationPlan,
  TransitionFailureReason,
  TransitionStage,
} from '../../../src/background/runtime-v2-types';
import type {
  DeferredBlockClaim as StoresDeferredBlockClaim,
  RuntimeTabState as StoresRuntimeTabState,
} from '../../../src/background/stores';
import type {
  BankState,
  CycleConfig,
  DailyAgg,
  GateState,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  ScheduleOccurrenceRef,
  SessionEndedEventV2,
  SessionRuleSnapshot,
  SessionStartedEventV2,
  SessionStateV2,
  SiteUnlock,
} from '../../../src/shared/types';

describe('background runtime v2 leaf contracts', (): void => {
  it('moves the v1 runtime leaves without changing their shapes', (): void => {
    expectTypeOf<RuntimeTabState>().toEqualTypeOf<{
      muteUrl: string | null;
      priorMuted: boolean | null;
      stoppedDocumentId: string | null;
    }>();
    expectTypeOf<DeferredBlockClaim>().toEqualTypeOf<{
      attemptAt: number;
      documentId?: string;
      kind: 'navigation' | 'existing';
      sessionId: string;
      stage: 'attempt' | 'stopped';
      tabId: number;
      url: string;
    }>();
    expectTypeOf<StoresRuntimeTabState>().toEqualTypeOf<RuntimeTabState>();
    expectTypeOf<StoresDeferredBlockClaim>().toEqualTypeOf<DeferredBlockClaim>();
  });

  it('pins transition candidates and cleanup authority', (): void => {
    expectTypeOf<TransitionFailureReason>().toEqualTypeOf<
      | 'website-access-lost'
      | 'content-registration-failed'
      | 'alarm-failed'
      | 'tab-enforcement-failed'
    >();
    expectTypeOf<StartDurationPlan>().toEqualTypeOf<
      | { kind: 'manual-timed'; minutes: number }
      | { kind: 'schedule-window' }
      | { kind: 'until-stopped' }
    >();
    expectTypeOf<CandidateScheduleWindow>().toEqualTypeOf<{
      windowStartsAt: number;
      windowEndsAt: number;
    }>();
    expectTypeOf<SessionStartCandidate>().toEqualTypeOf<{
      mode: 'blacklist' | 'whitelist';
      strictness: 'flexible' | 'friction' | 'hard';
      duration: StartDurationPlan;
      cycling: CycleConfig | null;
      intention: string;
      source: 'manual' | 'schedule';
      scheduleOccurrence: ScheduleOccurrenceRef | null;
      scheduleWindow: CandidateScheduleWindow | null;
      rules: SessionRuleSnapshot;
    }>();
    expectTypeOf<CleanupRetryState>().toEqualTypeOf<{
      batch: number;
      automaticAttempt: number;
      nextAttemptAt: number | null;
      lastError: string | null;
    }>();
    expectTypeOf<CleanupTabClaim>().toEqualTypeOf<{
      tabId: number;
      state: RuntimeTabState;
    }>();
    expectTypeOf<CleanupSeed>().toEqualTypeOf<{
      alarmNames: string[];
      tabClaims: CleanupTabClaim[];
    }>();
    expectTypeOf<CleanupEnforcementTarget>().toEqualTypeOf<{
      tabId: number;
      documentId: string;
      expectedUrl: string;
    }>();
    expectTypeOf<CleanupProgress>().toEqualTypeOf<{
      cleanupOperationId: string;
      clearRuntimeRevision: number;
      targets: Record<string, CleanupEnforcementTarget>;
      clearCommands: Record<string, FrozenDocumentCommand>;
      tabClaims: CleanupTabClaim[];
      resolvedTabIds: number[];
      retry: CleanupRetryState;
    }>();
  });

  it('pins frozen transition views and the complete transition journal', (): void => {
    expectTypeOf<PostCleanupClosure>().toEqualTypeOf<{
      projection: ClosureProjection;
      cleanupSeed: CleanupSeed;
    }>();
    expectTypeOf<FrozenTransitionView>().toEqualTypeOf<{
      capturedAt: number;
      operationId: string;
      enforcementEpoch: string;
      basePolicyRevision: number;
      runtimeRevision: number;
      documents: Record<string, FrozenDocumentCommand>;
    }>();
    expectTypeOf<PreparedTargetReservation>().toEqualTypeOf<{
      tabId: number;
      documentId: string;
      expectedUrl: string;
      commandKey: string;
    }>();
    expectTypeOf<TransitionStage>().toEqualTypeOf<
      | 'prepared'
      | 'registration-audited'
      | 'starting-verified'
      | 'committed-pending-verification'
      | 'alarm-ready'
      | 'active-verified'
      | 'cleanup'
    >();
    expectTypeOf<PendingEnforcementTransition>().toEqualTypeOf<{
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
    }>();
  });

  it('pins closure projection and stage variants', (): void => {
    expectTypeOf<ClosureProjection>().toEqualTypeOf<{
      closureId: string;
      sessionId: string;
      endedAt: number;
      reason:
        | 'timer-completed'
        | 'manual-completed'
        | 'manual-canceled'
        | 'website-access-lost'
        | 'content-registration-failed'
        | 'alarm-failed'
        | 'tab-enforcement-failed'
        | 'invalid-active-state';
      outcome: 'completed' | 'canceled';
      focusedMs: number;
      endEvent: SessionEndedEventV2;
      events: Array<LegacyEventRecord | SessionEndedEventV2>;
      handledOccurrences: HandledScheduleOccurrence[];
      completionIncrement: 0 | 1;
      bankAfter: BankState;
      aggregateSets: Record<string, DailyAgg>;
      aggregateRemoves: string[];
    }>();
    expectTypeOf<PendingClosure>().toEqualTypeOf<
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
        }
    >();
  });

  it('pins the v2 runtime projection, required checkpoint collections, and full state', (): void => {
    expectTypeOf<RuntimeDomainProjectionV2>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<RuntimeCommitCheckpointV2>().toEqualTypeOf<{
      version: 2;
      checkpointId: string;
      projection: RuntimeDomainProjectionV2;
      bank: BankState;
      events: Array<LegacyEventRecord | SessionStartedEventV2 | SessionEndedEventV2>;
      syncBank: boolean;
      aggregateSets: Record<string, DailyAgg>;
      aggregateRemoves: string[];
    }>();
    expectTypeOf<RuntimeStateV2>().toEqualTypeOf<{
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
    }>();
    expectTypeOf<Extract<'scheduleActiveEntryId', keyof RuntimeStateV2>>().toEqualTypeOf<never>();
  });
});
