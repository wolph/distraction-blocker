import { isDailyDate } from '../core/stats';
import { MAX_HANDLED_SCHEDULE_OCCURRENCES } from '../shared/constants';
import { exactDataEqual, snapshotExactData } from '../shared/exact-data';
import { isEventRecord, isSessionEventRecordV2 } from '../shared/runtime-validation';
import type { HandledScheduleOccurrence, LegacyEventRecord, SessionStateV2 } from '../shared/types';
import {
  everyDenseEntry,
  exactRecord,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  isSafeTimestamp,
  isUuid,
  validateDetachedGateState,
  validateDetachedSessionStateV2,
  validateDetachedSiteUnlock,
} from '../shared/v2-domain-intrinsics';
import {
  detachedIdentityMap,
  validateDetachedAggregateRemoves,
  validateDetachedAggregateSets,
  validateDetachedBankState,
  validateDetachedCleanupProgress,
  validateDetachedCleanupSeed,
  validateDetachedClosureProjection,
  validateDetachedDailyAgg,
  validateDetachedHandledScheduleOccurrence,
  validateDetachedPendingClosure,
  validateDetachedRuntimeTabState,
} from './cleanup-closure-v2-validation';
import type {
  EnforcementCheckpoint,
  EpochResetAckRecord,
  FrozenDocumentCommand,
} from './enforcement-persistence-v2';
import {
  validateDetachedEnforcementCheckpoint,
  validateDetachedEpochResetAckRecord,
  validateDetachedFrozenDocumentCommand,
} from './enforcement-persistence-v2-validation';
import type { DeferredBlockClaim, RuntimeTabState } from './runtime-leaf-types';
import type {
  CleanupProgress,
  ClosureProjection,
  LegacyMigrationFocusSettlement,
  MigrationCleanupPlan,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeCommitCheckpointV2,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import { validateDetachedPendingEnforcementTransition } from './transition-v2-validation';

type UnknownRecord = Record<string, unknown>;

/** The validated top-level values the whole-runtime relationships read. */
interface RuntimeAuthority {
  session: SessionStateV2 | null;
  handledScheduleOccurrences: HandledScheduleOccurrence[];
  enforcementEpoch: string;
  epochResetAcks: Record<string, EpochResetAckRecord>;
  basePolicyRevision: number;
  runtimeRevision: number;
  documentCommands: Record<string, FrozenDocumentCommand>;
  enforcementCheckpoint: EnforcementCheckpoint | null;
  transition: PendingEnforcementTransition | null;
  closure: PendingClosure | null;
  commitCheckpoint: RuntimeCommitCheckpointV2 | null;
}

const RUNTIME_KEYS: readonly string[] = [
  'runtimeSchemaVersion',
  'session',
  'gate',
  'unlocks',
  'tabStates',
  'accruedFocusMs',
  'attemptDebounce',
  'deferredBlockClaims',
  'removedTabTombstones',
  'scheduleUnavailableNoticeToken',
  'handledScheduleOccurrences',
  'enforcementEpoch',
  'epochResetAcks',
  'basePolicyRevision',
  'runtimeRevision',
  'documentCommands',
  'enforcementCheckpoint',
  'pendingEnforcementTransition',
  'pendingClosure',
  'date',
  'todayAgg',
  'lastPruneDate',
  'commitCheckpoint',
];
/** Every projected key names the identical top-level runtime field. */
const PROJECTION_KEYS: readonly string[] = [
  'session',
  'gate',
  'unlocks',
  'accruedFocusMs',
  'handledScheduleOccurrences',
  'enforcementEpoch',
  'epochResetAcks',
  'basePolicyRevision',
  'runtimeRevision',
  'documentCommands',
  'enforcementCheckpoint',
  'pendingEnforcementTransition',
  'pendingClosure',
];
const COMMIT_CHECKPOINT_KEYS: readonly string[] = [
  'version',
  'checkpointId',
  'projection',
  'bank',
  'events',
  'syncBank',
  'aggregateSets',
  'aggregateRemoves',
];
const DEFERRED_CLAIM_KEYS: readonly string[] = [
  'attemptAt',
  'kind',
  'sessionId',
  'stage',
  'tabId',
  'url',
];
const MIGRATION_CHECKPOINT_KEYS: readonly string[] = [
  'version',
  'fromRuntimeSchemaVersion',
  'toRuntimeSchemaVersion',
  'migratedAt',
  'assignedSessionId',
  'identityEvent',
  'projectedRuntime',
  'cleanupPlan',
  'marker',
];
const MIGRATION_CLEANUP_PLAN_KEYS: readonly string[] = [
  'version',
  'settlement',
  'projection',
  'cleanupSeed',
  'cleanupProgress',
];
const MIGRATION_SETTLEMENT_KEYS: readonly string[] = [
  'settledAt',
  'settledThrough',
  'phaseAtMigration',
  'focusedMsBefore',
  'creditedFocusMs',
  'focusedMsAfter',
];
const IDENTITY_EVENT_KEYS: readonly string[] = ['t', 'at', 'startedAt', 'sessionId'];
const MIGRATION_PHASES: ReadonlySet<string> = new Set<string>(['focus', 'break', 'paused']);
/** A migrated active session, and invalid-active cleanup, both reserve exactly one revision. */
const MIGRATION_ACTIVE_REVISION: number = 1;
/** An idle v1 profile migrates to a runtime that has issued no policy and no command. */
const MIGRATION_IDLE_REVISION: number = 0;
/** The stages that hold a durable focus session captured at the transition's own activation. */
const COMMITTED_TRANSITION_STAGES: ReadonlySet<string> = new Set<string>([
  'committed-pending-verification',
  'alarm-ready',
  'active-verified',
]);

export function parseRuntimeStateV2(value: unknown): RuntimeStateV2 | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedRuntimeStateV2(snapshot) ? snapshot : null;
}

export function parseRuntimeMigrationCheckpointV1ToV2(
  value: unknown,
): RuntimeMigrationCheckpointV1ToV2 | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedMigrationCheckpoint(snapshot) ? snapshot : null;
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. The checkpoint and its
 * marker are stored in one generation and validated as one value, so the projected runtime goes
 * through the same detached runtime rules `parseRuntimeStateV2` applies rather than a forked copy.
 */
function validateDetachedMigrationCheckpoint(
  value: unknown,
): value is RuntimeMigrationCheckpointV1ToV2 {
  const candidate: UnknownRecord | null = exactRecord(value, MIGRATION_CHECKPOINT_KEYS);
  const migratedAt: unknown = candidate?.migratedAt;
  const projectedRuntime: unknown = candidate?.projectedRuntime;
  if (
    candidate === null ||
    candidate.version !== 1 ||
    candidate.fromRuntimeSchemaVersion !== 1 ||
    candidate.toRuntimeSchemaVersion !== 2 ||
    !isSafeTimestamp(migratedAt) ||
    !isRuntimeSchemaMarkerValue(candidate.marker) ||
    !validateDetachedRuntimeStateV2(projectedRuntime) ||
    !projectsMigratedRuntime(projectedRuntime)
  ) {
    return false;
  }
  const plan: unknown = candidate.cleanupPlan;
  if (plan === null) {
    return (
      projectsMigratedDefaults(projectedRuntime) &&
      identityAgrees(candidate, migratedAt, projectedRuntime, null)
    );
  }
  return (
    validateDetachedMigrationCleanupPlan(plan, migratedAt) &&
    projectsCleanupPlan(projectedRuntime, plan) &&
    identityAgrees(candidate, migratedAt, projectedRuntime, plan)
  );
}

/**
 * The marker's shape, on already-detached exact plain data. `runtime-store-v2.ts` owns the standalone
 * guard that snapshots a stored value first, and it imports this module's parser, so the shape lives
 * on this side of that edge and the store's guard calls it rather than restating it.
 */
export function isRuntimeSchemaMarkerValue(value: unknown): boolean {
  const marker: UnknownRecord | null = exactRecord(value, ['runtimeSchemaVersion']);
  return marker !== null && marker.runtimeSchemaVersion === 2;
}

/**
 * Every migration writes a fresh epoch with no reset acknowledgements, replays nothing else through
 * a nested commit checkpoint, and never invents a pending transition.
 */
function projectsMigratedRuntime(runtime: RuntimeStateV2): boolean {
  return (
    runtime.commitCheckpoint === null &&
    runtime.pendingEnforcementTransition === null &&
    Object.keys(runtime.epochResetAcks).length === 0
  );
}

/**
 * A migration that had to derive a session UUID records it once, together with the identity event
 * that announces it at the same migration instant and names the session it was derived for. A
 * migration that reused a durable UUID, or that had no session at all, records neither.
 */
function identityAgrees(
  candidate: UnknownRecord,
  migratedAt: number,
  runtime: RuntimeStateV2,
  plan: MigrationCleanupPlan | null,
): boolean {
  const assignedSessionId: unknown = candidate.assignedSessionId;
  const identityEvent: unknown = candidate.identityEvent;
  if (assignedSessionId === null) return identityEvent === null;
  if (!isUuid(assignedSessionId) || !validateDetachedIdentityEvent(identityEvent)) return false;
  if (identityEvent.sessionId !== assignedSessionId || identityEvent.at !== migratedAt) {
    return false;
  }
  return namesMigratedSession(identityEvent, assignedSessionId, runtime, plan);
}

/**
 * The assigned UUID names the one session this checkpoint carries: the session its plan closes, or
 * the session it projects, whose `startedAt` the identity event binds. A migration that projects
 * neither has nothing to name, so it assigns nothing.
 */
function namesMigratedSession(
  identityEvent: Extract<LegacyEventRecord, { t: 'sessionIdentityAssigned' }>,
  assignedSessionId: string,
  runtime: RuntimeStateV2,
  plan: MigrationCleanupPlan | null,
): boolean {
  if (plan !== null) return plan.projection.sessionId === assignedSessionId;
  const session: SessionStateV2 | null = runtime.session;
  return (
    session !== null &&
    session.sessionId === assignedSessionId &&
    identityEvent.startedAt === session.startedAt
  );
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. The key gate adds exact-key
 * rejection to `isEventRecord`, which accepts the v1 records that carry extra keys.
 */
function validateDetachedIdentityEvent(
  value: unknown,
): value is Extract<LegacyEventRecord, { t: 'sessionIdentityAssigned' }> {
  const candidate: UnknownRecord | null = exactRecord(value, IDENTITY_EVENT_KEYS);
  return (
    candidate !== null && candidate.t === 'sessionIdentityAssigned' && isEventRecord(candidate)
  );
}

/**
 * Without a cleanup plan the projection is the migrated runtime itself. An idle profile has issued
 * nothing, and a migrated active session reserves one base policy and one runtime revision and
 * waits for standalone recovery to create its first commands and checkpoint. The closure a
 * migration can produce always arrives with its plan, so a projected closure here has no authority.
 */
function projectsMigratedDefaults(runtime: RuntimeStateV2): boolean {
  const revision: number =
    runtime.session === null ? MIGRATION_IDLE_REVISION : MIGRATION_ACTIVE_REVISION;
  return (
    runtime.pendingClosure === null &&
    runtime.enforcementCheckpoint === null &&
    Object.keys(runtime.documentCommands).length === 0 &&
    runtime.basePolicyRevision === revision &&
    runtime.runtimeRevision === revision
  );
}

/**
 * The plan is the checkpoint's own copy of the closure the projected runtime carries, so the
 * runtime holds no session and no checkpoint, exactly that closure at `cleanup`, and the reserved
 * base policy and clear revisions. Its top runtime revision follows from the clear revision, which
 * the runtime rules already tie to a cleanup closure.
 */
function projectsCleanupPlan(runtime: RuntimeStateV2, plan: MigrationCleanupPlan): boolean {
  const closure: PendingClosure | null = runtime.pendingClosure;
  if (
    runtime.session !== null ||
    runtime.enforcementCheckpoint !== null ||
    closure === null ||
    closure.stage !== 'cleanup' ||
    runtime.basePolicyRevision !== MIGRATION_ACTIVE_REVISION ||
    plan.cleanupProgress.clearRuntimeRevision !== MIGRATION_ACTIVE_REVISION
  ) {
    return false;
  }
  return (
    exactDataEqual(closure.projection, plan.projection) &&
    exactDataEqual(closure.cleanupSeed, plan.cleanupSeed) &&
    exactDataEqual(closure.cleanupProgress, plan.cleanupProgress)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedMigrationCleanupPlan(
  value: unknown,
  migratedAt: number,
): value is MigrationCleanupPlan {
  const candidate: UnknownRecord | null = exactRecord(value, MIGRATION_CLEANUP_PLAN_KEYS);
  const projection: unknown = candidate?.projection;
  const settlement: unknown = candidate?.settlement;
  if (
    candidate === null ||
    candidate.version !== 1 ||
    !validateDetachedClosureProjection(projection) ||
    !validateDetachedCleanupSeed(candidate.cleanupSeed) ||
    !validateDetachedCleanupProgress(candidate.cleanupProgress) ||
    !validateDetachedMigrationSettlement(settlement)
  ) {
    return false;
  }
  return (
    closesInvalidActiveState(projection, migratedAt) &&
    settlementAgrees(settlement, projection, migratedAt)
  );
}

/** Migration closes an invalid legacy active state, and only that, at the migration instant. */
function closesInvalidActiveState(projection: ClosureProjection, migratedAt: number): boolean {
  return (
    projection.reason === 'invalid-active-state' &&
    projection.outcome === 'canceled' &&
    projection.completionIncrement === 0 &&
    projection.endedAt === migratedAt
  );
}

/**
 * The settlement is the audit record of the one focus credit migration applies, so it settles at
 * the migration instant, never counts past it, and adds up to the focus the projection settled. A
 * durable focus phase is the only phase that credits anything.
 */
function settlementAgrees(
  settlement: LegacyMigrationFocusSettlement,
  projection: ClosureProjection,
  migratedAt: number,
): boolean {
  return (
    settlement.settledAt === migratedAt &&
    settlement.settledThrough <= migratedAt &&
    settlement.focusedMsBefore + settlement.creditedFocusMs === settlement.focusedMsAfter &&
    settlement.focusedMsAfter === projection.focusedMs &&
    (settlement.phaseAtMigration === 'focus' || settlement.creditedFocusMs === 0)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedMigrationSettlement(
  value: unknown,
): value is LegacyMigrationFocusSettlement {
  const candidate: UnknownRecord | null = exactRecord(value, MIGRATION_SETTLEMENT_KEYS);
  const phaseAtMigration: unknown = candidate?.phaseAtMigration;
  return (
    candidate !== null &&
    isSafeTimestamp(candidate.settledAt) &&
    isSafeTimestamp(candidate.settledThrough) &&
    typeof phaseAtMigration === 'string' &&
    MIGRATION_PHASES.has(phaseAtMigration) &&
    isSafeTimestamp(candidate.focusedMsBefore) &&
    isSafeTimestamp(candidate.creditedFocusMs) &&
    isSafeTimestamp(candidate.focusedMsAfter)
  );
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. Each subtree is validated
 * by the predicate that owns it, so this adds the top-level leaves plus the relationships only
 * whole-runtime authority can see.
 */
function validateDetachedRuntimeStateV2(value: unknown): value is RuntimeStateV2 {
  const candidate: UnknownRecord | null = exactRecord(value, RUNTIME_KEYS);
  if (candidate === null || candidate.runtimeSchemaVersion !== 2) return false;
  const authority: RuntimeAuthority | null = runtimeAuthority(candidate);
  if (authority === null) return false;
  return (
    resetAcksAgree(authority) &&
    documentCommandsAgree(authority) &&
    idleRuntimeHoldsNoCommands(authority) &&
    enforcementCheckpointAgrees(authority) &&
    transitionAgrees(authority) &&
    closureAgrees(authority) &&
    commitCheckpointProjectsRuntime(authority, candidate)
  );
}

/** Returns the runtime's own authority, or null when any leaf is out of domain. */
function runtimeAuthority(candidate: UnknownRecord): RuntimeAuthority | null {
  const session: unknown = candidate.session;
  const handledScheduleOccurrences: unknown = candidate.handledScheduleOccurrences;
  const enforcementEpoch: unknown = candidate.enforcementEpoch;
  const basePolicyRevision: unknown = candidate.basePolicyRevision;
  const runtimeRevision: unknown = candidate.runtimeRevision;
  if (
    !validateDetachedRuntimeLeaves(candidate) ||
    !isNullOr(session, validateDetachedSessionStateV2) ||
    !validateDetachedHandledOccurrenceLog(handledScheduleOccurrences) ||
    !isUuid(enforcementEpoch) ||
    !isNonNegativeInteger(basePolicyRevision) ||
    !isNonNegativeInteger(runtimeRevision)
  ) {
    return null;
  }
  const epochResetAcks: Record<string, EpochResetAckRecord> | null = detachedIdentityMap(
    candidate.epochResetAcks,
    validateDetachedEpochResetAckRecord,
  );
  const documentCommands: Record<string, FrozenDocumentCommand> | null = detachedIdentityMap(
    candidate.documentCommands,
    validateDetachedFrozenDocumentCommand,
  );
  const enforcementCheckpoint: unknown = candidate.enforcementCheckpoint;
  const transition: unknown = candidate.pendingEnforcementTransition;
  const closure: unknown = candidate.pendingClosure;
  const commitCheckpoint: unknown = candidate.commitCheckpoint;
  if (
    epochResetAcks === null ||
    documentCommands === null ||
    !isNullOr(enforcementCheckpoint, validateDetachedEnforcementCheckpoint) ||
    !isNullOr(transition, validateDetachedPendingEnforcementTransition) ||
    !isNullOr(closure, validateDetachedPendingClosure) ||
    !isNullOr(commitCheckpoint, validateDetachedRuntimeCommitCheckpoint)
  ) {
    return null;
  }
  return {
    session,
    handledScheduleOccurrences,
    enforcementEpoch,
    epochResetAcks,
    basePolicyRevision,
    runtimeRevision,
    documentCommands,
    enforcementCheckpoint,
    transition,
    closure,
    commitCheckpoint,
  };
}

/** The leaves no later relationship reads, in the order the stored record declares them. */
function validateDetachedRuntimeLeaves(candidate: UnknownRecord): boolean {
  const date: unknown = candidate.date;
  const todayAgg: unknown = candidate.todayAgg;
  if (
    !isNullOr(candidate.gate, validateDetachedGateState) ||
    !everyDenseEntry(candidate.unlocks, validateDetachedSiteUnlock) ||
    !validateDetachedRuntimeTabStates(candidate.tabStates) ||
    !isNonNegativeInteger(candidate.accruedFocusMs) ||
    !validateDetachedAttemptDebounce(candidate.attemptDebounce) ||
    !validateDetachedDeferredBlockClaims(candidate.deferredBlockClaims) ||
    !validateDetachedRemovedTabTombstones(candidate.removedTabTombstones) ||
    !isNullOr(candidate.scheduleUnavailableNoticeToken, isStoredNoticeToken) ||
    !isDailyDate(date) ||
    !isNullOr(candidate.lastPruneDate, isDailyDate)
  ) {
    return false;
  }
  return todayAgg === null || validateDetachedDailyAgg(todayAgg, date);
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. The projection repeats
 * validated top-level fields, so its exact key set is checked here and its values are checked by
 * the structural equality every projected field owes the runtime around it.
 */
function validateDetachedRuntimeCommitCheckpoint(
  value: unknown,
): value is RuntimeCommitCheckpointV2 {
  const candidate: UnknownRecord | null = exactRecord(value, COMMIT_CHECKPOINT_KEYS);
  return (
    candidate !== null &&
    candidate.version === 2 &&
    typeof candidate.checkpointId === 'string' &&
    exactRecord(candidate.projection, PROJECTION_KEYS) !== null &&
    validateDetachedBankState(candidate.bank) &&
    everyDenseEntry(candidate.events, isSessionEventRecordV2) &&
    typeof candidate.syncBank === 'boolean' &&
    validateDetachedAggregateSets(candidate.aggregateSets) &&
    validateDetachedAggregateRemoves(candidate.aggregateRemoves)
  );
}

/**
 * Records are unique by token and stay under the deterministic retention cap. Stored order is
 * whatever the last merge and prune produced, so no ordering rule applies to the log itself.
 */
function validateDetachedHandledOccurrenceLog(
  value: unknown,
): value is HandledScheduleOccurrence[] {
  if (
    !everyDenseEntry(value, validateDetachedHandledScheduleOccurrence) ||
    value.length > MAX_HANDLED_SCHEDULE_OCCURRENCES
  ) {
    return false;
  }
  const tokens: Set<string> = new Set<string>(
    value.map((occurrence: HandledScheduleOccurrence): string => occurrence.token),
  );
  return tokens.size === value.length;
}

/** Every stored acknowledgement is current-epoch authority, and carries no runtime revision. */
function resetAcksAgree(authority: RuntimeAuthority): boolean {
  return Object.values(authority.epochResetAcks).every(
    (ack: EpochResetAckRecord): boolean => ack.enforcementEpoch === authority.enforcementEpoch,
  );
}

/**
 * Every stored command carries the current epoch. The revision and base policy equalities hold only
 * while the map is the current authority. A pre-commit or committed transition freezes its own
 * replacement view and raises the top revision to it without touching the map, so the retained
 * batch legitimately keeps the older tuple until cleanup entry or closure commit replaces it.
 */
function documentCommandsAgree(authority: RuntimeAuthority): boolean {
  const transition: PendingEnforcementTransition | null = authority.transition;
  const currentAuthority: boolean = transition === null || transition.stage === 'cleanup';
  return Object.values(authority.documentCommands).every(
    (command: FrozenDocumentCommand): boolean =>
      command.enforcementEpoch === authority.enforcementEpoch &&
      (!currentAuthority ||
        (command.runtimeRevision === authority.runtimeRevision &&
          command.basePolicyRevision === authority.basePolicyRevision)),
  );
}

/**
 * An idle runtime holds no document commands. Every write that removes a journal from a runtime
 * with no session empties the map with it, the closure removal and the abandoned start alike, and
 * an idle runtime persists a command for no page it is asked about. A command on an idle runtime
 * is a page address nothing will ever send to, so it is refused rather than carried.
 */
function idleRuntimeHoldsNoCommands(authority: RuntimeAuthority): boolean {
  const idle: boolean =
    authority.session === null && authority.transition === null && authority.closure === null;
  return !idle || Object.keys(authority.documentCommands).length === 0;
}

/**
 * A stored focus checkpoint is publishable authority for the durable session it names. It repeats
 * the runtime epoch and base policy revision, and its acknowledged revisions are never compared
 * with the current runtime revision. A pending transition is deliberately not publishable, so a
 * transition carries none, which is also what keeps a recovery-kind checkpoint standalone.
 */
function enforcementCheckpointAgrees(authority: RuntimeAuthority): boolean {
  const checkpoint: EnforcementCheckpoint | null = authority.enforcementCheckpoint;
  const session: SessionStateV2 | null = authority.session;
  if (checkpoint === null) return true;
  return (
    authority.transition === null &&
    session !== null &&
    session.phase === 'focus' &&
    checkpoint.sessionId === session.sessionId &&
    checkpoint.enforcementEpoch === authority.enforcementEpoch &&
    checkpoint.basePolicyRevision === authority.basePolicyRevision
  );
}

/** A stored transition is the current runtime authority and never coexists with a closure. */
function transitionAgrees(authority: RuntimeAuthority): boolean {
  const transition: PendingEnforcementTransition | null = authority.transition;
  if (transition === null) return true;
  const progress: CleanupProgress | null = transition.cleanupProgress;
  if (
    authority.closure !== null ||
    transition.enforcementEpoch !== authority.enforcementEpoch ||
    transition.runtimeRevision !== authority.runtimeRevision ||
    !transitionBaseRevisionAgrees(transition, authority.basePolicyRevision) ||
    (progress !== null && !exactDataEqual(authority.documentCommands, progress.clearCommands))
  ) {
    return false;
  }
  return transition.stage === 'cleanup'
    ? cleanupTransitionSessionAgrees(transition, authority.session)
    : transitionStageSessionAgrees(transition, authority.session);
}

/**
 * Commit stores the base policy revision the transition reserved, and abandonment persists it with
 * the clear batch so later content commands stay monotonic, so from either write onward the durable
 * runtime carries it. A pre-commit start stage is the one place whose reservation legitimately
 * leads the durable base, and a pre-commit resume never moved it.
 */
function transitionBaseRevisionAgrees(
  transition: PendingEnforcementTransition,
  basePolicyRevision: number,
): boolean {
  const reserving: boolean =
    transition.kind === 'start' &&
    transition.stage !== 'cleanup' &&
    !COMMITTED_TRANSITION_STAGES.has(transition.stage);
  return reserving || transition.basePolicyRevision === basePolicyRevision;
}

/**
 * A pre-commit start has no session yet, a pre-commit resume still holds its saved pause or break,
 * and every committed stage holds the focus session that its captured activation started.
 */
function transitionStageSessionAgrees(
  transition: PendingEnforcementTransition,
  session: SessionStateV2 | null,
): boolean {
  if (!COMMITTED_TRANSITION_STAGES.has(transition.stage)) {
    return transition.kind === 'start' ? session === null : retainsPriorPhase(transition, session);
  }
  if (
    session === null ||
    session.phase !== 'focus' ||
    session.sessionId !== transition.sessionId ||
    session.phaseStartedAt !== transition.activationAt
  ) {
    return false;
  }
  return transition.kind === 'resume' || session.startedAt === transition.activationAt;
}

/**
 * Cleanup keeps the session its cause implies. Abandonment leaves none, restoration keeps the exact
 * saved phase, and a closing cause keeps the matching durable session frozen at the projected
 * logical end until the one-checkpoint handoff installs the closure.
 */
function cleanupTransitionSessionAgrees(
  transition: PendingEnforcementTransition,
  session: SessionStateV2 | null,
): boolean {
  const closure: PendingEnforcementTransition['postCleanupClosure'] = transition.postCleanupClosure;
  if (closure === null) {
    return transition.cleanupCause === 'start-abandon'
      ? session === null
      : retainsPriorPhase(transition, session);
  }
  return (
    session !== null &&
    session.sessionId === transition.sessionId &&
    session.phaseStartedAt <= closure.projection.endedAt
  );
}

function retainsPriorPhase(
  transition: PendingEnforcementTransition,
  session: SessionStateV2 | null,
): boolean {
  return (
    session !== null &&
    session.sessionId === transition.sessionId &&
    session.phase === transition.priorPhase
  );
}

/**
 * A prepared closure still owns its durable session, because logical closure has not committed. A
 * cleanup closure has committed it away and owns the current clear batch and handled records.
 */
function closureAgrees(authority: RuntimeAuthority): boolean {
  const closure: PendingClosure | null = authority.closure;
  if (closure === null) return true;
  const sessionId: string = closure.projection.sessionId;
  if (closure.stage === 'prepared') return preparedClosureSessionAgrees(authority, sessionId);
  const progress: CleanupProgress = closure.cleanupProgress;
  return (
    authority.session === null &&
    authority.runtimeRevision === progress.clearRuntimeRevision &&
    exactDataEqual(authority.documentCommands, progress.clearCommands) &&
    closureClearCommandsAgree(authority, progress, sessionId) &&
    projectsHandledRecords(authority, closure.projection.handledOccurrences)
  );
}

/**
 * Logical closure wrote its handled records, so the top-level log holds no record the immutable
 * projection does not, structurally and in the projection's own order. It may hold fewer: the
 * maintenance tick prunes an expired record while a multi-day cleanup is still retrying, and that
 * prune must not make the journal that owns the browser cleanup unparseable.
 */
function projectsHandledRecords(
  authority: RuntimeAuthority,
  projected: readonly HandledScheduleOccurrence[],
): boolean {
  let next: number = 0;
  for (const record of authority.handledScheduleOccurrences) {
    while (next < projected.length && !exactDataEqual(projected[next], record)) next += 1;
    if (next === projected.length) return false;
    next += 1;
  }
  return true;
}

/** The prior session stays durable unless a stored commit checkpoint already projects it gone. */
function preparedClosureSessionAgrees(authority: RuntimeAuthority, sessionId: string): boolean {
  const session: SessionStateV2 | null = authority.session;
  if (session !== null) return session.sessionId === sessionId;
  return authority.commitCheckpoint?.projection.session === null;
}

/**
 * Every closure clear command is current runtime authority for the closed durable session. The
 * null reserved identity restates what a durable session ID already forces on a canonical command.
 */
function closureClearCommandsAgree(
  authority: RuntimeAuthority,
  progress: CleanupProgress,
  sessionId: string,
): boolean {
  return Object.values(progress.clearCommands).every(
    (command: FrozenDocumentCommand): boolean =>
      command.sessionId === sessionId &&
      command.reservedSessionId === null &&
      command.enforcementEpoch === authority.enforcementEpoch &&
      command.basePolicyRevision === authority.basePolicyRevision &&
      command.runtimeRevision === progress.clearRuntimeRevision &&
      command.operationId === progress.cleanupOperationId,
  );
}

/**
 * The runtime stored around a v2 commit checkpoint equals its projection for every projected field.
 * Set and remove collections carry no invented disjointness rule.
 */
function commitCheckpointProjectsRuntime(
  authority: RuntimeAuthority,
  candidate: UnknownRecord,
): boolean {
  const checkpoint: RuntimeCommitCheckpointV2 | null = authority.commitCheckpoint;
  if (checkpoint === null) return true;
  return Object.entries(checkpoint.projection).every(
    ([key, projected]: [string, unknown]): boolean => exactDataEqual(projected, candidate[key]),
  );
}

/** Accepts only already-detached exact plain data keyed by canonical decimal tab IDs. */
function validateDetachedRuntimeTabStates(
  value: unknown,
): value is Record<number, RuntimeTabState> {
  const entries: Array<[number, unknown]> | null = detachedTabIdEntries(value);
  if (entries === null) return false;
  return entries.every(([, state]: [number, unknown]): boolean =>
    validateDetachedRuntimeTabState(state),
  );
}

/** A tombstone is the marker itself: the tab ID key and the exact literal `true`. */
function validateDetachedRemovedTabTombstones(value: unknown): value is Record<number, true> {
  const entries: Array<[number, unknown]> | null = detachedTabIdEntries(value);
  if (entries === null) return false;
  return entries.every(([, marker]: [number, unknown]): boolean => marker === true);
}

/** Debounce marks are wall-clock instants under the attempt keys the engine owns. */
function validateDetachedAttemptDebounce(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  const keys: string[] | null = detachedRecordKeys(value);
  if (keys === null) return false;
  return keys.every((key: string): boolean => isSafeTimestamp(value[key]));
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedDeferredBlockClaims(
  value: unknown,
): value is Record<string, DeferredBlockClaim> {
  if (!isRecord(value)) return false;
  const keys: string[] | null = detachedRecordKeys(value);
  if (keys === null) return false;
  return keys.every((key: string): boolean => validateDetachedDeferredBlockClaim(value[key]));
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. A stopped claim names the
 * navigation document it stopped, so it is the only claim that carries the optional document ID.
 */
function validateDetachedDeferredBlockClaim(value: unknown): value is DeferredBlockClaim {
  if (!isRecord(value)) return false;
  const keys: string[] | null = detachedRecordKeys(value);
  if (keys === null || !hasDeferredClaimKeys(keys)) return false;
  const documentId: boolean = keys.includes('documentId');
  if (
    !isSafeTimestamp(value.attemptAt) ||
    (value.kind !== 'navigation' && value.kind !== 'existing') ||
    !isNonBlankString(value.sessionId) ||
    (value.stage !== 'attempt' && value.stage !== 'stopped') ||
    !isNonNegativeInteger(value.tabId) ||
    !isNonBlankString(value.url) ||
    (documentId && !isNonBlankString(value.documentId))
  ) {
    return false;
  }
  return value.stage !== 'stopped' || (value.kind === 'navigation' && documentId);
}

function hasDeferredClaimKeys(keys: readonly string[]): boolean {
  return (
    DEFERRED_CLAIM_KEYS.every((key: string): boolean => keys.includes(key)) &&
    keys.every((key: string): boolean => DEFERRED_CLAIM_KEYS.includes(key) || key === 'documentId')
  );
}

/** Returns the record's own string keys, or null for a symbol key or a non-record container. */
function detachedRecordKeys(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (keys.some((key: PropertyKey): boolean => typeof key !== 'string')) return null;
  return keys as string[];
}

/** Tab-keyed runtime maps use the canonical decimal tab ID, so no other spelling is accepted. */
function detachedTabIdEntries(value: unknown): Array<[number, unknown]> | null {
  if (!isRecord(value)) return null;
  const keys: string[] | null = detachedRecordKeys(value);
  if (keys === null) return null;
  const entries: Array<[number, unknown]> = [];
  for (const key of keys) {
    const tabId: number = Number(key);
    if (!isNonNegativeInteger(tabId) || String(tabId) !== key) return null;
    entries.push([tabId, value[key]]);
  }
  return entries;
}

/**
 * The notice token is an opaque identity the schedule runner compares, and the version 1 reader
 * stores any string. Requiring a non-blank one is tighter than both that shape and the spec, and a
 * migrated runtime carrying an empty token would be refused for a field nothing else reads.
 */
function isStoredNoticeToken(value: unknown): value is string {
  return typeof value === 'string';
}

function isNullOr<T>(
  value: unknown,
  validate: (candidate: unknown) => candidate is T,
): value is T | null {
  return value === null || validate(value);
}
