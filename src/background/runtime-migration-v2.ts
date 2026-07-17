/**
 * The one-way v1 to v2 migration builder: legacy occurrence marker parsing, legacy session and
 * config migration, and the complete migration checkpoint.
 *
 * The builder is pure over already-parsed v1 input. It reads no storage and no Settings, allocates
 * no identifier of its own, and returns only a checkpoint the storage parser accepts. Anything it
 * cannot express as a valid checkpoint raises `CoreError('invalid-rule', ...)` rather than reaching
 * a caller, because a migration that writes a value the boot reader rejects strands the profile.
 */

import { createHandledScheduleOccurrenceV2 } from '../core/schedule-v2';
import { CoreError } from '../shared/errors';
import {
  isScheduleOccurrenceRef,
  isSessionConfigV2,
  isSessionStateV2,
} from '../shared/runtime-validation';
import type {
  BankState,
  DailyAgg,
  LegacyEventRecord,
  NormalizedSessionConfigV1,
  NormalizedSessionStateV1,
  PauseEconomy,
  ScheduleOccurrenceRef,
  SessionConfigV2,
  SessionDuration,
  SessionEndedEventV2,
  SessionStateV2,
} from '../shared/types';
import {
  isNonBlankString,
  isRecord,
  isSafeTimestamp,
  isUuid,
} from '../shared/v2-domain-intrinsics';
import { buildCleanupProgressV2, buildCleanupSeedV2 } from './cleanup-progress-v2';
import { closureIdV2 } from './closure-projection-v2';
import { type LegacySettlementResultV1, settleLegacySessionV1 } from './legacy-runtime-v1';
import { emptyRuntimeV2 } from './runtime-store-v2';
import type {
  CleanupProgress,
  CleanupSeed,
  ClosureProjection,
  MigrationCleanupPlan,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeMigrationCheckpointV1ToV2 } from './runtime-v2-validation';
import type { LegacyRuntimeStateV1 } from './stores';

export interface MigrationInputV2 {
  /** The parsed v1 runtime, with any legacy commit checkpoint already replayed and cleared. */
  runtime: LegacyRuntimeStateV1;
  bank: BankState;
  pauseEconomy: PauseEconomy;
  deviceId: string;
  migratedAt: number;
  enforcementEpoch: string;
  cleanupOperationId: string;
  /** The caller allocates this once, and only when the legacy session lacks its own UUID. */
  assignedSessionId: string | null;
  /**
   * Stored aggregates keyed by `syncAggKey` for every local date the legacy settlement can split.
   * A date already finished must be seeded from its stored aggregate, and a stale future
   * `runtime.date` after a backward clock or westward timezone change makes that reachable, so the
   * caller loads the whole range rather than letting the settlement refuse an earlier date.
   */
  priorAggregates: Record<string, DailyAgg>;
}

/** The migrated session the checkpoint carries, before the projection is assembled around it. */
interface MigratedSessionV2 {
  sessionId: string;
  assigned: string | null;
  session: SessionStateV2 | null;
  occurrence: ScheduleOccurrenceRef | null;
}

/** A migrated active session reserves one base policy revision and one runtime revision. */
const MIGRATION_ACTIVE_REVISION: number = 1;
/** The session boundary alarm is the only alarm a migrated cleanup owns. */
const MIGRATION_CLEANUP_ALARMS: readonly string[] = ['phase'];

/**
 * Reads the stored `scheduleActiveEntryId` marker as a version 1 occurrence reference. Only the
 * exact `entryId@YYYY-MM-DD` form of the session's own entry qualifies. The current v1 writer stores
 * a bare entry ID or an entry ID with the window-end timestamp, and neither carries a local start
 * date, so neither can name an occurrence. Nothing here reconstructs a date from anywhere else.
 */
export function parseLegacyScheduleOccurrenceMarkerV1(
  marker: string | null,
  entryId: string | null,
): ScheduleOccurrenceRef | null {
  if (marker === null || entryId === null || !isNonBlankString(entryId)) return null;
  // The reference validator owns both halves of the rule: its token must be exactly
  // `${entryId}@${localStartDate}`, which rejects another entry's marker and any marker with no
  // separator, and its local date must be a real calendar date. Nothing is compared twice here.
  // The last separator, not the first: the token is `${entryId}@${localStartDate}` and an entry ID
  // may contain an `@` of its own, which splitting at the first one would strand in the date half.
  const separator: number = marker.lastIndexOf('@');
  const occurrence: ScheduleOccurrenceRef = {
    version: 1,
    token: marker,
    entryId,
    localStartDate: marker.slice(separator + 1),
  };
  return isScheduleOccurrenceRef(occurrence) ? occurrence : null;
}

/**
 * Maps one legacy config to its v2 shape: the numeric duration becomes the tagged timed duration,
 * the null duration of a v1 indefinite session becomes until-stopped, the schedule entry ID becomes
 * the validated occurrence, and every other field carries over. A scheduled config without its
 * occurrence, or a manual one carrying an occurrence, has no v2 form. Strictness is kept as stored:
 * the v2 contract refuses Hard with no timer, and that refusal is what routes such a session to the
 * invalid-active closure so its focus still settles.
 */
export function migrateLegacySessionConfigV1(
  config: NormalizedSessionConfigV1,
  occurrence: ScheduleOccurrenceRef | null,
): SessionConfigV2 | null {
  const migrated: SessionConfigV2 = {
    mode: config.mode,
    strictness: config.strictness,
    duration: migratedDurationV1(config.durationMin),
    // The v1 reader never pairs cycling with a null duration, and an until-stopped session has no
    // finite end for cycling to divide, so the pair maps to cycling off rather than to a config
    // the v2 contract refuses.
    cycling: config.cycling === null || config.durationMin === null ? null : { ...config.cycling },
    intention: config.intention,
    source: config.source,
    scheduleOccurrence: occurrence === null ? null : { ...occurrence },
    rules: structuredClone(config.rules),
  };
  return isSessionConfigV2(migrated) ? migrated : null;
}

/** The v1 duration was minutes or, for the indefinite session, null. */
function migratedDurationV1(durationMin: number | null): SessionDuration {
  return durationMin === null ? { kind: 'until-stopped' } : { kind: 'timed', minutes: durationMin };
}

/**
 * Maps one legacy session to its v2 shape, keeping every absolute endpoint. A legacy value the v2
 * session contract rejects has no v2 form, and migration closes it instead of publishing it.
 */
export function migrateLegacySessionStateV1(
  session: NormalizedSessionStateV1 & { sessionId: string },
  occurrence: ScheduleOccurrenceRef | null,
): SessionStateV2 | null {
  const config: SessionConfigV2 | null = migrateLegacySessionConfigV1(session.config, occurrence);
  if (config === null) return null;
  const migrated: SessionStateV2 = {
    version: 2,
    sessionId: session.sessionId,
    config,
    startedAt: session.startedAt,
    sessionEndsAt: session.sessionEndsAt,
    phase: session.phase,
    phaseStartedAt: session.phaseStartedAt,
    phaseEndsAt: clampedPhaseEndV1(session),
    cycleIndex: session.cycleIndex,
    pausedFrom: session.pausedFrom === null ? null : { ...session.pausedFrom },
    focusedMs: session.focusedMs,
  };
  return isSessionStateV2(migrated) ? migrated : null;
}

/**
 * v1 could begin a pause whose end ran past the fixed session end, which the v2 session contract
 * refuses. The pause is clamped to that end exactly as `beginPauseV2` clamps a new one, so a session
 * paused in its final minutes migrates instead of being force-closed. A clamp that still leaves an
 * invalid state falls through to the invalid-active route like any other unmigratable session. An
 * indefinite session has no session end to clamp to, so its deadlines carry over as stored.
 */
function clampedPhaseEndV1(session: NormalizedSessionStateV1): number | null {
  if (
    session.phase !== 'paused' ||
    session.phaseEndsAt === null ||
    session.sessionEndsAt === null
  ) {
    return session.phaseEndsAt;
  }
  return Math.min(session.phaseEndsAt, session.sessionEndsAt);
}

/**
 * Builds the complete migration checkpoint: the projected v2 runtime, the optional identity event
 * for a derived UUID, the optional invalid-active cleanup plan, and the schema marker. The result is
 * the parser's own output, so it is detached from the legacy runtime it read and every caller
 * receives a value the storage boundary already accepted.
 */
export function buildRuntimeMigrationCheckpointV1ToV2(
  input: MigrationInputV2,
): RuntimeMigrationCheckpointV1ToV2 {
  assertMigrationInput(input);
  const legacy: NormalizedSessionStateV1 | null = input.runtime.session;
  return validatedCheckpoint(
    legacy === null ? idleCheckpoint(input) : sessionCheckpoint(input, legacy),
  );
}

function idleCheckpoint(input: MigrationInputV2): RuntimeMigrationCheckpointV1ToV2 {
  return migrationCheckpoint(input, carriedRuntimeV2(input), null, null);
}

/**
 * A legacy session migrates when it has a v2 form. A scheduled session needs the exact stored
 * occurrence marker, so a bare or window-end marker leaves an active state with no valid v2 config.
 * Every session without a v2 form is closed through the invalid-active cleanup plan rather than
 * dropped, so its focus, bank, and aggregates still settle exactly once.
 */
function sessionCheckpoint(
  input: MigrationInputV2,
  legacy: NormalizedSessionStateV1,
): RuntimeMigrationCheckpointV1ToV2 {
  const migrated: MigratedSessionV2 = migrateLegacySession(input, legacy);
  if (migrated.session === null) return invalidActiveCheckpoint(input, legacy, migrated);
  const runtime: RuntimeStateV2 = {
    ...carriedRuntimeV2(input),
    session: migrated.session,
    handledScheduleOccurrences: handledStartRecords(
      migrated.occurrence,
      migrated.session.startedAt,
    ),
    basePolicyRevision: MIGRATION_ACTIVE_REVISION,
    runtimeRevision: MIGRATION_ACTIVE_REVISION,
  };
  return migrationCheckpoint(input, runtime, migrated, null);
}

function migrateLegacySession(
  input: MigrationInputV2,
  legacy: NormalizedSessionStateV1,
): MigratedSessionV2 {
  const sessionId: string = migratedSessionId(input, legacy);
  const occurrence: ScheduleOccurrenceRef | null =
    legacy.config.source === 'schedule'
      ? parseLegacyScheduleOccurrenceMarkerV1(
          input.runtime.scheduleActiveEntryId,
          legacy.config.scheduleEntryId,
        )
      : null;
  return {
    sessionId,
    assigned: input.assignedSessionId,
    session: migrateLegacySessionStateV1({ ...legacy, sessionId }, occurrence),
    occurrence,
  };
}

/**
 * The migrated session keeps its durable UUID, or takes the one the caller allocated for it. The
 * builder stays pure, so it never derives an identity of its own.
 */
function migratedSessionId(input: MigrationInputV2, legacy: NormalizedSessionStateV1): string {
  const durable: string | undefined = legacy.sessionId;
  if (durable !== undefined) {
    if (input.assignedSessionId !== null) {
      invalidMigration('a legacy session with its own UUID cannot receive an assigned one');
    }
    return durable;
  }
  if (input.assignedSessionId === null) {
    invalidMigration('a legacy session without a UUID needs one assigned by the caller');
  }
  return input.assignedSessionId;
}

/**
 * The migrated occurrence was already started in v1, so its token stays suppressed for the rest of
 * its window. The marker stored no handled time, and the session start is the only factual instant
 * for that token.
 */
function handledStartRecords(
  occurrence: ScheduleOccurrenceRef | null,
  startedAt: number,
): RuntimeStateV2['handledScheduleOccurrences'] {
  if (occurrence === null) return [];
  return [createHandledScheduleOccurrenceV2(occurrence, startedAt, 'started')];
}

/**
 * An active state with no v2 form is closed at the migration instant. The settlement credits the
 * legacy focus once, the projection is the immutable logical end, and the cleanup plan owns the
 * browser effects that recovery will finish. The projected runtime carries the same closure, so no
 * second write is needed to install it.
 */
function invalidActiveCheckpoint(
  input: MigrationInputV2,
  legacy: NormalizedSessionStateV1,
  migrated: MigratedSessionV2,
): RuntimeMigrationCheckpointV1ToV2 {
  const settled: LegacySettlementResultV1 = settleLegacySessionV1({
    session: legacy,
    bank: input.bank,
    pauseEconomy: input.pauseEconomy,
    accruedFocusMs: input.runtime.accruedFocusMs,
    todayAgg: input.runtime.todayAgg,
    runtimeDate: input.runtime.date,
    deviceId: input.deviceId,
    priorAggregates: input.priorAggregates,
    migratedAt: input.migratedAt,
  });
  const plan: MigrationCleanupPlan = migrationCleanupPlan(input, legacy, migrated, settled);
  const runtime: RuntimeStateV2 = {
    ...carriedRuntimeV2(input),
    gate: null,
    unlocks: [],
    handledScheduleOccurrences: handledStartRecords(migrated.occurrence, legacy.startedAt),
    // The session is logically closed, and v1 resets this watermark at every no-session site, so
    // the next session starts crediting from zero rather than from a closed session's focus.
    accruedFocusMs: 0,
    todayAgg: structuredClone(settled.todayAgg),
    basePolicyRevision: MIGRATION_ACTIVE_REVISION,
    runtimeRevision: MIGRATION_ACTIVE_REVISION,
    pendingClosure: {
      version: 1,
      stage: 'cleanup',
      projection: plan.projection,
      cleanupSeed: plan.cleanupSeed,
      cleanupProgress: plan.cleanupProgress,
    },
  };
  return migrationCheckpoint(input, runtime, migrated, plan);
}

function migrationCleanupPlan(
  input: MigrationInputV2,
  legacy: NormalizedSessionStateV1,
  migrated: MigratedSessionV2,
  settled: LegacySettlementResultV1,
): MigrationCleanupPlan {
  const seed: CleanupSeed = buildCleanupSeedV2(MIGRATION_CLEANUP_ALARMS, input.runtime.tabStates);
  const progress: CleanupProgress = buildCleanupProgressV2({
    cleanupOperationId: input.cleanupOperationId,
    clearRuntimeRevision: MIGRATION_ACTIVE_REVISION,
    // Migration enumerates no document. Recovery adds every owned target before its first clear.
    targets: [],
    identity: {
      enforcementEpoch: input.enforcementEpoch,
      sessionId: migrated.sessionId,
      reservedSessionId: null,
      basePolicyRevision: MIGRATION_ACTIVE_REVISION,
    },
    seed,
    at: input.migratedAt,
    batch: 0,
  });
  return {
    version: 1,
    settlement: settled.settlement,
    projection: migrationClosureProjection(input, legacy, migrated, settled),
    cleanupSeed: seed,
    cleanupProgress: progress,
  };
}

/**
 * The immutable logical end of an invalid active state: canceled at the migration instant, with the
 * settled focus, the bank and aggregates the settlement produced, and the exact legacy budget event
 * before the end event. No occurrence token is fabricated for a session that never had one.
 */
function migrationClosureProjection(
  input: MigrationInputV2,
  legacy: NormalizedSessionStateV1,
  migrated: MigratedSessionV2,
  settled: LegacySettlementResultV1,
): ClosureProjection {
  const sessionId: string = migrated.sessionId;
  const endEvent: SessionEndedEventV2 = {
    version: 2,
    t: 'sessionEnded',
    eventId: `${sessionId}:end`,
    at: input.migratedAt,
    sessionId,
    outcome: 'canceled',
    reason: 'invalid-active-state',
    focusedMs: settled.settlement.focusedMsAfter,
    // The end event reports the duration the session actually had, and an invalid-active
    // cancellation is a valid end for either kind.
    duration: migratedDurationV1(legacy.config.durationMin),
    source: legacy.config.source,
    scheduleOccurrence: null,
  };
  return {
    closureId: closureIdV2(sessionId),
    sessionId,
    endedAt: input.migratedAt,
    reason: endEvent.reason,
    outcome: endEvent.outcome,
    focusedMs: endEvent.focusedMs,
    endEvent,
    events: settlementEvents(input, sessionId, settled, endEvent),
    // Spec 1633: the record is present when it is factually present. A scheduled session whose
    // endpoints have no v2 form was still started under its occurrence, so the token stays
    // suppressed for the rest of its window rather than letting the scheduler restart the window
    // the migration has just closed. The legacy start is the only factual instant for it.
    handledOccurrences: handledStartRecords(migrated.occurrence, legacy.startedAt),
    completionIncrement: 0,
    bankAfter: { ...settled.bankAfter },
    aggregateSets: structuredClone(settled.aggregateSets),
    aggregateRemoves: [],
  };
}

/** The legacy engine records a budget event only when the settlement actually banked something. */
function settlementEvents(
  input: MigrationInputV2,
  sessionId: string,
  settled: LegacySettlementResultV1,
  endEvent: SessionEndedEventV2,
): Array<LegacyEventRecord | SessionEndedEventV2> {
  if (settled.earnedMs <= 0) return [endEvent];
  return [{ t: 'budgetEarned', at: input.migratedAt, ms: settled.earnedMs, sessionId }, endEvent];
}

/**
 * The v2 runtime keeps every v1 field it still owns, including the live gate, the live unlocks, and
 * the accrual watermark, because dropping them would lose durable user state. `scheduleActiveEntryId`
 * is migration input only and has no v2 field. Every leaf is detached from the legacy runtime.
 *
 * A gate belongs to a session. A v1 worker evicted between a session end and its gate clear leaves
 * one behind with no session, and the v2 runtime contract refuses that pair, so a gate is carried
 * only when there is a legacy session for it to belong to.
 */
function carriedRuntimeV2(input: MigrationInputV2): RuntimeStateV2 {
  const legacy: LegacyRuntimeStateV1 = input.runtime;
  return {
    ...emptyRuntimeV2(input.migratedAt, input.enforcementEpoch),
    gate: legacy.gate === null || legacy.session === null ? null : { ...legacy.gate },
    unlocks: legacy.unlocks.map((unlock: LegacyRuntimeStateV1['unlocks'][number]) => ({
      ...unlock,
    })),
    tabStates: structuredClone(legacy.tabStates),
    accruedFocusMs: legacy.accruedFocusMs,
    attemptDebounce: { ...legacy.attemptDebounce },
    deferredBlockClaims: structuredClone(legacy.deferredBlockClaims),
    removedTabTombstones: { ...legacy.removedTabTombstones },
    scheduleUnavailableNoticeToken: legacy.scheduleUnavailableNoticeToken,
    date: legacy.date,
    todayAgg: legacy.todayAgg === null ? null : structuredClone(legacy.todayAgg),
    lastPruneDate: legacy.lastPruneDate,
  };
}

function migrationCheckpoint(
  input: MigrationInputV2,
  projectedRuntime: RuntimeStateV2,
  migrated: MigratedSessionV2 | null,
  cleanupPlan: MigrationCleanupPlan | null,
): RuntimeMigrationCheckpointV1ToV2 {
  const assigned: string | null = migrated?.assigned ?? null;
  return {
    version: 1,
    fromRuntimeSchemaVersion: 1,
    toRuntimeSchemaVersion: 2,
    migratedAt: input.migratedAt,
    assignedSessionId: assigned,
    identityEvent:
      assigned === null
        ? null
        : {
            t: 'sessionIdentityAssigned',
            at: input.migratedAt,
            startedAt: legacyStartedAt(input),
            sessionId: assigned,
          },
    projectedRuntime,
    cleanupPlan,
    marker: { runtimeSchemaVersion: 2 },
  };
}

/** Only a legacy session can carry an assignment, so its start instant is always available. */
function legacyStartedAt(input: MigrationInputV2): number {
  const session: NormalizedSessionStateV1 | null = input.runtime.session;
  if (session === null) invalidMigration('an identity event needs the legacy session it names');
  return session.startedAt;
}

/**
 * The checkpoint is worthless unless the boot reader accepts it, so the builder returns the parser's
 * own detached output and fails loudly rather than handing back a value that would strand migration.
 */
function validatedCheckpoint(
  checkpoint: RuntimeMigrationCheckpointV1ToV2,
): RuntimeMigrationCheckpointV1ToV2 {
  const parsed: RuntimeMigrationCheckpointV1ToV2 | null =
    parseRuntimeMigrationCheckpointV1ToV2(checkpoint);
  if (parsed === null) {
    invalidMigration('the migrated runtime does not satisfy the v2 migration checkpoint contract');
  }
  return parsed;
}

/**
 * Everything the builder cannot derive is the caller's to supply. Captured rules must already be
 * normalized through the legacy rules migration, because this module never reads Settings or the
 * persisted lists to reconstruct them.
 */
function assertMigrationInput(input: MigrationInputV2): void {
  if (!isSafeTimestamp(input.migratedAt)) {
    invalidMigration('the migration instant must be a non-negative safe integer');
  }
  if (!isUuid(input.enforcementEpoch)) {
    invalidMigration('migration allocates one fresh enforcement epoch UUID');
  }
  if (input.assignedSessionId !== null && !isUuid(input.assignedSessionId)) {
    invalidMigration('an assigned session identity must be a UUID');
  }
  const session: NormalizedSessionStateV1 | null = input.runtime.session;
  if (session === null) {
    if (input.assignedSessionId !== null) {
      invalidMigration('an idle migration has no session to assign an identity to');
    }
    return;
  }
  if (!isRecord(session.config.rules)) {
    invalidMigration('a legacy session config needs rules normalized by the caller');
  }
  if (!isUuid(input.cleanupOperationId)) {
    invalidMigration('migration allocates one cleanup operation UUID for an active session');
  }
}

function invalidMigration(message: string): never {
  throw new CoreError('invalid-rule', message);
}
