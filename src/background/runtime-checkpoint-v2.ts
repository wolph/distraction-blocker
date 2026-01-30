/**
 * The one v2 commit checkpoint. A logical commit writes the projected runtime with its checkpoint
 * first, flushes events, bank, and aggregates in a fixed order, and only then clears the checkpoint.
 * Every step after that first write is idempotent, so a worker that dies mid-flush finishes the same
 * commit on the next boot by replaying the stored checkpoint.
 *
 * Ports are plain interfaces. This module performs no storage and no browser call of its own.
 */

import { capAttempts } from '../core/stats';
import { TOP_SITES_DAILY } from '../shared/constants';
import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import type { BankState, DailyAgg, SessionEventRecordV2 } from '../shared/types';
import type {
  CleanupProgress,
  PendingClosure,
  PendingEnforcementTransition,
  RuntimeCommitCheckpointV2,
  RuntimeDomainProjectionV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

/** Every projected key names the identical top-level runtime field. */
const PROJECTED_KEYS: readonly ProjectedKeyV2[] = [
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

type ProjectedKeyV2 = keyof RuntimeDomainProjectionV2;

/** The installed cleanup batch plus the journal that owns it, which retry batches never cross. */
interface CleanupBatchV2 {
  kind: 'closure' | 'transition';
  progress: CleanupProgress;
}

export interface RuntimeCheckpointPortsV2 {
  saveRuntime(runtime: RuntimeStateV2): Promise<void>;
  /**
   * The composed with-checkpoint runtime, handed over the moment it is durable and before the
   * replay starts. A second holder of the runtime has to carry the checkpoint from here: a write of
   * its own inside the replay window would otherwise store a projection older than the events, bank,
   * and aggregates this commit has already flushed, and a crash there would replay none of them.
   */
  publishCheckpointRuntime?(runtime: RuntimeStateV2): void;
  appendEvents(events: readonly SessionEventRecordV2[]): Promise<void>;
  saveBank(bank: BankState, syncBank: boolean): Promise<void>;
  saveAggregate(key: string, value: DailyAgg): Promise<void>;
  removeAggregate(key: string): Promise<void>;
}

export interface RuntimeCommitInputV2 {
  checkpointId: string;
  projection: RuntimeDomainProjectionV2;
  bank: BankState;
  events: SessionEventRecordV2[];
  syncBank: boolean;
  aggregateSets: Record<string, DailyAgg>;
  aggregateRemoves: string[];
}

/** The thirteen runtime fields a commit checkpoint owns, detached from the runtime that held them. */
export function projectRuntimeDomainV2(runtime: RuntimeStateV2): RuntimeDomainProjectionV2 {
  return structuredClone({
    session: runtime.session,
    gate: runtime.gate,
    unlocks: runtime.unlocks,
    accruedFocusMs: runtime.accruedFocusMs,
    handledScheduleOccurrences: runtime.handledScheduleOccurrences,
    enforcementEpoch: runtime.enforcementEpoch,
    epochResetAcks: runtime.epochResetAcks,
    basePolicyRevision: runtime.basePolicyRevision,
    runtimeRevision: runtime.runtimeRevision,
    documentCommands: runtime.documentCommands,
    enforcementCheckpoint: runtime.enforcementCheckpoint,
    pendingEnforcementTransition: runtime.pendingEnforcementTransition,
    pendingClosure: runtime.pendingClosure,
  });
}

/** The runtime stored around a checkpoint owes the projection exact equality, field by field. */
export function runtimeMatchesProjectionV2(
  runtime: RuntimeStateV2,
  projection: RuntimeDomainProjectionV2,
): boolean {
  return PROJECTED_KEYS.every((key: ProjectedKeyV2): boolean =>
    exactDataEqual(projection[key], runtime[key]),
  );
}

/** Projects the checkpoint over a runtime and stores it. Fields the projection omits are kept. */
export function applyRuntimeCheckpointV2(
  runtime: RuntimeStateV2,
  checkpoint: RuntimeCommitCheckpointV2,
): RuntimeStateV2 {
  return structuredClone({
    ...runtime,
    ...checkpoint.projection,
    commitCheckpoint: checkpoint,
  });
}

/**
 * One durable commit. Both the runtime that carries the checkpoint and the runtime that replay will
 * leave behind are validated before the first write, so a checkpoint no replay could ever finish
 * never becomes durable, and no port runs for a rejected commit.
 */
export async function commitRuntimeCheckpointV2(
  ports: RuntimeCheckpointPortsV2,
  runtime: RuntimeStateV2,
  input: RuntimeCommitInputV2,
): Promise<RuntimeStateV2> {
  if (input.projection.runtimeRevision < runtime.runtimeRevision) {
    throw new CoreError(
      'invalid-rule',
      'a commit checkpoint never lowers the monotonic runtime revision',
    );
  }
  if (input.projection.basePolicyRevision < runtime.basePolicyRevision) {
    throw new CoreError(
      'invalid-rule',
      'a commit checkpoint never lowers the monotonic base policy revision',
    );
  }
  assertCleanupBatchAdvance(runtimeCleanupBatch(runtime), projectedCleanupBatch(input.projection));
  const checkpoint: RuntimeCommitCheckpointV2 = {
    version: 2,
    checkpointId: input.checkpointId,
    projection: input.projection,
    bank: input.bank,
    events: input.events,
    syncBank: input.syncBank,
    aggregateSets: input.aggregateSets,
    aggregateRemoves: input.aggregateRemoves,
  };
  const withCheckpoint: RuntimeStateV2 = validatedRuntime(
    composedCheckpointRuntime(runtime, checkpoint),
    'a commit checkpoint must compose a valid runtime',
  );
  validatedRuntime(
    { ...withCheckpoint, commitCheckpoint: null },
    'a commit checkpoint must clear to a valid runtime',
  );
  await ports.saveRuntime(withCheckpoint);
  ports.publishCheckpointRuntime?.(structuredClone(withCheckpoint));
  return replayRuntimeCheckpointV2(ports, withCheckpoint);
}

/**
 * Finishes whatever the stored checkpoint still owes. Reapplying the projection first is what makes
 * a replay after a partial write converge, and clearing the checkpoint last is what ends the commit.
 *
 * The caller passes a runtime `parseRuntimeStateV2` already accepted, because replay flushes before
 * it validates. A validated store cannot hand this function a drifted runtime either, since the
 * parser makes a stored runtime that disagrees with its own projection invalid, so the reapplication
 * below repairs only an unvalidated or hand-built runtime.
 */
export async function replayRuntimeCheckpointV2(
  ports: RuntimeCheckpointPortsV2,
  runtime: RuntimeStateV2,
): Promise<RuntimeStateV2> {
  const checkpoint: RuntimeCommitCheckpointV2 | null = runtime.commitCheckpoint;
  if (checkpoint === null) return runtime;
  const projected: RuntimeStateV2 = runtimeMatchesProjectionV2(runtime, checkpoint.projection)
    ? runtime
    : composedCheckpointRuntime(runtime, checkpoint);
  await ports.appendEvents(checkpoint.events);
  await ports.saveBank(checkpoint.bank, checkpoint.syncBank);
  for (const [key, value] of sortedAggregateSets(checkpoint.aggregateSets)) {
    await ports.saveAggregate(key, capAttempts(value, TOP_SITES_DAILY));
  }
  for (const key of checkpoint.aggregateRemoves) {
    await ports.removeAggregate(key);
  }
  const cleared: RuntimeStateV2 = validatedRuntime(
    { ...projected, commitCheckpoint: null },
    'a replayed checkpoint must leave a valid runtime',
  );
  await ports.saveRuntime(cleared);
  return cleared;
}

/** Flush order is the sorted key order, so two replays of one checkpoint write the same sequence. */
function sortedAggregateSets(aggregateSets: Record<string, DailyAgg>): Array<[string, DailyAgg]> {
  return Object.entries(aggregateSets).sort(
    ([left]: [string, DailyAgg], [right]: [string, DailyAgg]): number =>
      left === right ? 0 : left < right ? -1 : 1,
  );
}

/**
 * One cleanup journal owns one operation ID. Every automatic attempt in that batch reuses the ID,
 * the clear revision, and the frozen commands, so a repeated content clear is idempotent, and a
 * manual retry spends one durable checkpoint on a new UUID, a higher clear revision, and the next
 * retry batch. A replacement that reused its revision would leave an in-flight command from the
 * abandoned batch carrying the same revision tuple as the new one, which content cannot tell apart.
 *
 * A transition that hands its cleanup to a closure is the one replacement that crosses journals. It
 * still advances beyond the transition's clear revision, but it starts its own retry counting, so
 * the batch rule applies only within one journal kind.
 */
function assertCleanupBatchAdvance(
  before: CleanupBatchV2 | null,
  after: CleanupBatchV2 | null,
): void {
  if (before === null || after === null) return;
  const from: CleanupProgress = before.progress;
  const to: CleanupProgress = after.progress;
  if (to.cleanupOperationId === from.cleanupOperationId) {
    if (to.clearRuntimeRevision !== from.clearRuntimeRevision) {
      throw new CoreError('invalid-rule', 'an automatic cleanup retry keeps its clear revision');
    }
    if (to.retry.batch !== from.retry.batch) {
      throw new CoreError('invalid-rule', 'a new cleanup retry batch allocates a new operation ID');
    }
    return;
  }
  if (to.clearRuntimeRevision <= from.clearRuntimeRevision) {
    throw new CoreError('invalid-rule', 'a replacement cleanup batch advances the clear revision');
  }
  if (before.kind !== after.kind) return;
  if (to.retry.batch !== from.retry.batch + 1 || to.retry.automaticAttempt !== 0) {
    throw new CoreError('invalid-rule', 'a replacement cleanup batch begins the next retry batch');
  }
}

function runtimeCleanupBatch(runtime: RuntimeStateV2): CleanupBatchV2 | null {
  return cleanupBatch(runtime.pendingClosure, runtime.pendingEnforcementTransition);
}

function projectedCleanupBatch(projection: RuntimeDomainProjectionV2): CleanupBatchV2 | null {
  return cleanupBatch(projection.pendingClosure, projection.pendingEnforcementTransition);
}

/** A runtime carries at most one journal, so at most one cleanup batch is installed at a time. */
function cleanupBatch(
  closure: PendingClosure | null,
  transition: PendingEnforcementTransition | null,
): CleanupBatchV2 | null {
  if (closure !== null && closure.stage === 'cleanup') {
    return { kind: 'closure', progress: closure.cleanupProgress };
  }
  if (transition === null || transition.cleanupProgress === null) return null;
  return { kind: 'transition', progress: transition.cleanupProgress };
}

function composedCheckpointRuntime(
  runtime: RuntimeStateV2,
  checkpoint: RuntimeCommitCheckpointV2,
): RuntimeStateV2 {
  try {
    return applyRuntimeCheckpointV2(runtime, checkpoint);
  } catch {
    throw new CoreError('invalid-rule', 'a commit checkpoint must hold cloneable exact data');
  }
}

/** Returns the detached runtime the parser accepted, so no unstorable runtime reaches a port. */
function validatedRuntime(runtime: RuntimeStateV2, message: string): RuntimeStateV2 {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) throw new CoreError('invalid-rule', message);
  return parsed;
}
