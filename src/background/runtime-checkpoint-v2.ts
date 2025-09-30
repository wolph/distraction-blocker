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

export interface RuntimeCheckpointPortsV2 {
  saveRuntime(runtime: RuntimeStateV2): Promise<void>;
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
 * One durable commit. The composed runtime is validated before the first write, so a checkpoint that
 * could not be replayed never becomes durable, and no port runs for a rejected commit.
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
  await ports.saveRuntime(withCheckpoint);
  return replayRuntimeCheckpointV2(ports, withCheckpoint);
}

/**
 * Finishes whatever the stored checkpoint still owes. Reapplying the projection first is what makes
 * a replay after a partial write converge, and clearing the checkpoint last is what ends the commit.
 */
export async function replayRuntimeCheckpointV2(
  ports: RuntimeCheckpointPortsV2,
  runtime: RuntimeStateV2,
): Promise<RuntimeStateV2> {
  const checkpoint: RuntimeCommitCheckpointV2 | null = runtime.commitCheckpoint;
  if (checkpoint === null) return runtime;
  const projected: RuntimeStateV2 = runtimeMatchesProjectionV2(runtime, checkpoint.projection)
    ? runtime
    : applyRuntimeCheckpointV2(runtime, checkpoint);
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
