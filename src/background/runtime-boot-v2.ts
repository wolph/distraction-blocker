/**
 * The ordered boot reader: exactly one v2 runtime authority, resolved before anything else runs.
 *
 * The order is the spec's migration order. A stored migration checkpoint outranks every other
 * stored value, because it is the durable record of a migration that was already decided and may
 * only be finished. A parseable v2 runtime is authority next. A legacy runtime migrates once. A
 * stored value this reader cannot trust is reported and replaced by an empty runtime rather than
 * reinterpreted.
 *
 * Every storage effect is a port, so this module performs no storage call, no browser call, and no
 * lifecycle projection of its own. The caller runs recovery and publication after it returns.
 */

import { CoreError } from '../shared/errors';
import { LOCAL_RUNTIME_MIGRATION, LOCAL_RUNTIME_SCHEMA, syncAggKey } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import type {
  BankState,
  DailyAgg,
  ListsConfig,
  PauseEconomy,
  SessionEventRecordV2,
} from '../shared/types';
import {
  type LegacyReplayPortsV1,
  type LegacyReplayResultV1,
  replayLegacyRuntimeCheckpointV1,
} from './legacy-runtime-v1';
import { type RuntimeCheckpointPortsV2, replayRuntimeCheckpointV2 } from './runtime-checkpoint-v2';
import {
  buildRuntimeMigrationCheckpointV1ToV2,
  type MigrationInputV2,
} from './runtime-migration-v2';
import { emptyRuntimeV2, type StoredRuntimeAuthority } from './runtime-store-v2';
import type {
  MigrationCleanupPlan,
  RuntimeMigrationCheckpointV1ToV2,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeMigrationCheckpointV1ToV2 } from './runtime-v2-validation';
import { mergeRuntime, migrateRuntimeRules, type RuntimeState } from './stores';

export interface RuntimeBootPortsV2 extends RuntimeCheckpointPortsV2, LegacyReplayPortsV1 {
  now(): number;
  newId(): string;
  loadRuntimeAuthority(): Promise<StoredRuntimeAuthority>;
  readMigrationCheckpoint(): Promise<unknown>;
  writeMigrationCheckpointAndMarker(checkpoint: RuntimeMigrationCheckpointV1ToV2): Promise<void>;
  clearMigrationCheckpoint(): Promise<void>;
  /** Stored daily aggregates by `syncAggKey`. A key with nothing stored is omitted. */
  loadAggregates(keys: readonly string[]): Promise<Record<string, DailyAgg>>;
  /** The persisted lists snapshot the legacy rules migration completes a config from, never Settings. */
  lists(): ListsConfig;
  /**
   * The bank as it stood when the boot began. It is a snapshot: a caller may bind it to a value
   * parsed once, so nothing after a replay may trust it. Every step that needs the current balance
   * takes it from the replay that stored it.
   */
  bank(): BankState;
  pauseEconomy(): PauseEconomy;
  deviceId(): string;
  reportError(error: unknown): void;
}

export type RuntimeBootResultV2 =
  | { kind: 'v2'; runtime: RuntimeStateV2; migrated: false }
  | { kind: 'migrated'; runtime: RuntimeStateV2; migrated: true }
  | { kind: 'rejected'; runtime: RuntimeStateV2; reason: 'marker-without-v2' | 'invalid-v2' };

/** The reported value is a diagnostic, not authority, so it is bounded before it leaves here. */
const REJECTED_VALUE_MAX_CHARS: number = 4096;
/**
 * A legacy session cannot have banked focus older than this, and a corrupt stored `startedAt` must
 * not turn one boot into an unbounded key list, so the loaded window starts here at the latest.
 */
const SETTLEMENT_AGGREGATE_WINDOW_DAYS: number = 366;

/**
 * Resolves the one runtime authority this profile boots from, finishing whatever the last worker
 * left unfinished. Steps 1 through 7 of the spec's migration order live here in that exact order.
 */
export async function bootRuntimeAuthorityV2(
  ports: RuntimeBootPortsV2,
): Promise<RuntimeBootResultV2> {
  const authority: StoredRuntimeAuthority = await ports.loadRuntimeAuthority();
  const storedMigration: unknown = await ports.readMigrationCheckpoint();
  const stored: RuntimeMigrationCheckpointV1ToV2 | null =
    parseRuntimeMigrationCheckpointV1ToV2(storedMigration);
  // A decided migration is finished before any other verdict, including the marker cutoff, which
  // only means "a marker with no checkpoint left to explain it" once this read comes back empty.
  if (stored !== null) return migratedBoot(await replayMigrationCheckpoint(ports, stored));
  // A stored value that no parser accepts is inert here, and the branches below are right to ignore
  // it, but the reader knows something is wrong: the rejected branch says so in its message, and
  // every other branch says so here rather than re-reading it silently on every future boot.
  if (storedMigration !== undefined && authority.kind !== 'rejected') {
    ports.reportError(
      new CoreError(
        'invalid-rule',
        'a stored migration checkpoint failed to parse and was ignored',
      ),
    );
  }
  switch (authority.kind) {
    case 'v2':
      return {
        kind: 'v2',
        runtime: await replayRuntimeCheckpointV2(ports, authority.runtime),
        migrated: false,
      };
    case 'rejected':
      return rejectedBoot(ports, authority, storedMigration);
    case 'absent':
      return { kind: 'v2', runtime: await freshRuntime(ports), migrated: false };
    default:
      return migratedBoot(await migrateLegacyRuntime(ports, authority.raw));
  }
}

/**
 * The one storage write that installs a migration: the checkpoint and the marker together. The
 * marker never travels alone, so it can never outlive the checkpoint that explains it.
 */
export function migrationStoragePayload(
  checkpoint: RuntimeMigrationCheckpointV1ToV2,
): Record<string, unknown> {
  return {
    [LOCAL_RUNTIME_MIGRATION]: checkpoint,
    [LOCAL_RUNTIME_SCHEMA]: checkpoint.marker,
  };
}

/**
 * Migration order steps 3 through 6. Rules are completed from the persisted lists snapshot, the
 * legacy checkpoint is flushed with legacy semantics before any v2 port runs, the aggregates the
 * settlement may split are loaded, one UUID is allocated only for a session that lacks one, and the
 * whole checkpoint becomes durable in one write before any of it is replayed.
 */
async function migrateLegacyRuntime(
  ports: RuntimeBootPortsV2,
  raw: unknown,
): Promise<RuntimeStateV2> {
  const now: number = ports.now();
  const normalized: RuntimeState = migrateRuntimeRules(mergeRuntime(raw, now), ports.lists());
  const replayed: LegacyReplayResultV1 = await replayLegacyRuntimeCheckpointV1(ports, normalized);
  const priorAggregates: Record<string, DailyAgg> = await loadSettlementAggregates(
    ports,
    replayed.runtime,
    now,
  );
  const input: MigrationInputV2 = {
    runtime: replayed.runtime,
    // The replay may have stored a newer bank than the boot-time snapshot, and the settlement must
    // build on what is durable, or it would overwrite the credit the crashed v1 commit earned.
    bank: replayed.bank ?? ports.bank(),
    pauseEconomy: ports.pauseEconomy(),
    deviceId: ports.deviceId(),
    migratedAt: now,
    enforcementEpoch: ports.newId(),
    cleanupOperationId: ports.newId(),
    assignedSessionId: assignedSessionIdFor(ports, replayed.runtime),
    priorAggregates,
  };
  const checkpoint: RuntimeMigrationCheckpointV1ToV2 = buildRuntimeMigrationCheckpointV1ToV2(input);
  await ports.writeMigrationCheckpointAndMarker(checkpoint);
  return replayMigrationCheckpoint(ports, checkpoint);
}

/**
 * Migration order step 7. Every write is idempotent, so a worker that dies part way through repeats
 * the same writes on the next boot from the stored checkpoint and converges on the same runtime.
 * Clearing the checkpoint last is what ends the migration, and the marker stays behind forever.
 */
async function replayMigrationCheckpoint(
  ports: RuntimeBootPortsV2,
  checkpoint: RuntimeMigrationCheckpointV1ToV2,
): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = checkpoint.projectedRuntime;
  await ports.saveRuntime(runtime);
  const events: SessionEventRecordV2[] = migrationEvents(checkpoint);
  if (events.length > 0) await ports.appendEvents(events);
  const plan: MigrationCleanupPlan | null = checkpoint.cleanupPlan;
  if (plan !== null) await replayMigrationCleanupPlan(ports, plan);
  await ports.clearMigrationCheckpoint();
  return runtime;
}

/**
 * The settled bank is written unconditionally, exactly as `replayRuntimeCheckpointV2` writes its
 * own. Comparing it with a boot-time snapshot would skip the write whenever that snapshot went
 * stale, and writing the same balance twice is idempotent.
 */
async function replayMigrationCleanupPlan(
  ports: RuntimeBootPortsV2,
  plan: MigrationCleanupPlan,
): Promise<void> {
  await ports.saveBank(plan.projection.bankAfter, true);
  // The settlement already capped every aggregate it produced, so these are stored as they are.
  for (const [key, value] of sortedAggregateSets(plan.projection.aggregateSets)) {
    await ports.saveAggregate(key, value);
  }
  for (const key of plan.projection.aggregateRemoves) {
    await ports.removeAggregate(key);
  }
}

/** The identity event announces the session before the closure that may end it. */
function migrationEvents(checkpoint: RuntimeMigrationCheckpointV1ToV2): SessionEventRecordV2[] {
  const identity: SessionEventRecordV2[] =
    checkpoint.identityEvent === null ? [] : [checkpoint.identityEvent];
  const closure: SessionEventRecordV2[] =
    checkpoint.cleanupPlan === null ? [] : [...checkpoint.cleanupPlan.projection.events];
  return [...identity, ...closure];
}

/** Flush order is the sorted key order, so two replays of one checkpoint write the same sequence. */
function sortedAggregateSets(aggregateSets: Record<string, DailyAgg>): Array<[string, DailyAgg]> {
  return Object.entries(aggregateSets).sort(
    ([left]: [string, DailyAgg], [right]: [string, DailyAgg]): number =>
      left === right ? 0 : left < right ? -1 : 1,
  );
}

/**
 * The settlement splits its banked focus across local dates, and a date already finished must be
 * loaded rather than seeded empty. Only a legacy session can settle, so an idle profile loads
 * nothing.
 */
async function loadSettlementAggregates(
  ports: RuntimeBootPortsV2,
  runtime: RuntimeState,
  now: number,
): Promise<Record<string, DailyAgg>> {
  if (runtime.session === null) return {};
  return ports.loadAggregates(
    settlementAggregateKeys(ports.deviceId(), runtime.session.startedAt, now),
  );
}

/** Every local date from the session start through the migration instant, one key per date. */
function settlementAggregateKeys(deviceId: string, startedAt: number, now: number): string[] {
  const earliest: number = localDayStart(now) - SETTLEMENT_AGGREGATE_WINDOW_DAYS * 86_400_000;
  const cursor: Date = new Date(Math.max(startedAt, earliest));
  // Walking midday to midday keeps one step exactly one local date, across every clock change.
  cursor.setHours(12, 0, 0, 0);
  const last: Date = new Date(now);
  last.setHours(12, 0, 0, 0);
  const keys: string[] = [];
  while (cursor.getTime() <= last.getTime()) {
    keys.push(syncAggKey(deviceId, localDateStr(cursor.getTime())));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function localDayStart(at: number): number {
  const start: Date = new Date(at);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

/** A legacy session that never carried a UUID receives exactly one, allocated here and nowhere else. */
function assignedSessionIdFor(ports: RuntimeBootPortsV2, runtime: RuntimeState): string | null {
  const session: RuntimeState['session'] = runtime.session;
  return session !== null && session.sessionId === undefined ? ports.newId() : null;
}

/**
 * A stored value this reader cannot trust is reported and left alone. The empty runtime that
 * replaces it is the only write, so nothing overwrites the rejected value until that save lands,
 * and the rejected value is never parked under another key.
 */
async function rejectedBoot(
  ports: RuntimeBootPortsV2,
  authority: Extract<StoredRuntimeAuthority, { kind: 'rejected' }>,
  storedMigration: unknown,
): Promise<RuntimeBootResultV2> {
  ports.reportError(new CoreError('invalid-rule', rejectionMessage(authority, storedMigration)));
  return { kind: 'rejected', runtime: await freshRuntime(ports), reason: authority.reason };
}

async function freshRuntime(ports: RuntimeBootPortsV2): Promise<RuntimeStateV2> {
  const runtime: RuntimeStateV2 = emptyRuntimeV2(ports.now(), ports.newId());
  await ports.saveRuntime(runtime);
  return runtime;
}

function migratedBoot(runtime: RuntimeStateV2): RuntimeBootResultV2 {
  return { kind: 'migrated', runtime, migrated: true };
}

/**
 * Names both values that could have caused the refusal, so the report identifies the offending data
 * rather than only its verdict. Neither is parked under another storage key.
 */
function rejectionMessage(
  authority: Extract<StoredRuntimeAuthority, { kind: 'rejected' }>,
  storedMigration: unknown,
): string {
  const parts: string[] = [`stored runtime authority rejected as ${authority.reason}`];
  const runtime: string | null = truncatedJson(authority.raw);
  const migration: string | null = truncatedJson(storedMigration);
  if (runtime !== null) parts.push(`runtime ${runtime}`);
  if (migration !== null) parts.push(`migration checkpoint ${migration}`);
  return parts.join('. ');
}

/** Serializes a rejected value for the report. It is hostile input, so nothing here may throw. */
function truncatedJson(value: unknown): string | null {
  if (value === undefined) return null;
  try {
    const json: string = JSON.stringify(value) ?? String(value);
    return json.length <= REJECTED_VALUE_MAX_CHARS
      ? json
      : `${json.slice(0, REJECTED_VALUE_MAX_CHARS)}...`;
  } catch {
    return '[unserializable stored value]';
  }
}
