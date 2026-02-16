/**
 * The v2 runtime storage boundary: the empty runtime, the schema marker, stored-authority
 * classification, and the validated save.
 *
 * Every write goes through `parseRuntimeStateV2` first, so a value this module persists is always a
 * value the reader accepts. Every read classifies before anything downstream may act on it, so a
 * hostile or half-migrated stored value can never reach the domain as authority. All runtime
 * authority lives in `chrome.storage.local`, and nothing here writes Sync.
 */

import { CoreError } from '../shared/errors';
import { type ExactDataSnapshot, snapshotExactData } from '../shared/exact-data';
import { LOCAL_RUNTIME, LOCAL_RUNTIME_SCHEMA } from '../shared/storage-keys';
import { localDateStr } from '../shared/time';
import { isRecord, isSafeTimestamp } from '../shared/v2-domain-intrinsics';
import type { RuntimeStateV2 } from './runtime-v2-types';
import { isRuntimeSchemaMarkerValue, parseRuntimeStateV2 } from './runtime-v2-validation';
import { readStoredRuntimeRaw } from './stores';

/**
 * The keys a v1 runtime never carried. Their presence on an unversioned value means the stored
 * shape is a mixed graph, which the v1 reader must refuse rather than migrate.
 */
const V2_ONLY_RUNTIME_KEYS: readonly string[] = [
  'enforcementEpoch',
  'epochResetAcks',
  'basePolicyRevision',
  'runtimeRevision',
  'documentCommands',
  'enforcementCheckpoint',
  'pendingEnforcementTransition',
  'pendingClosure',
  'handledScheduleOccurrences',
];

export interface RuntimeSchemaMarkerV2 {
  runtimeSchemaVersion: 2;
}

/** The one marker value this worker writes and returns, so no caller spells the literal again. */
export const RUNTIME_SCHEMA_MARKER_V2: RuntimeSchemaMarkerV2 = { runtimeSchemaVersion: 2 };

export type StoredRuntimeAuthority =
  | { kind: 'absent' }
  | { kind: 'v2'; runtime: RuntimeStateV2 }
  | { kind: 'legacy'; raw: unknown }
  /**
   * `raw` is the stored value this verdict refused. It exists so the boot reader can report what it
   * threw away, is unvalidated and possibly hostile, and must never be read as authority or
   * traversed outside a serializer that cannot throw.
   */
  | { kind: 'rejected'; reason: 'marker-without-v2' | 'invalid-v2'; raw: unknown };

/**
 * The idle v2 runtime a clean install and a rejected stored runtime both boot from.
 *
 * `now` reaches storage as the runtime's local-date watermark, and an unsafe instant would produce a
 * date the parser refuses on the next boot, so it is refused here where the caller can see which
 * argument was wrong. The epoch is checked by the parser on the way to storage rather than here,
 * because the worker's own identity source is not a UUID in every harness that builds a runtime.
 */
export function emptyRuntimeV2(now: number, enforcementEpoch: string): RuntimeStateV2 {
  if (!isSafeTimestamp(now)) {
    throw new CoreError('invalid-rule', 'an empty runtime needs a safe creation instant');
  }
  return {
    runtimeSchemaVersion: 2,
    session: null,
    gate: null,
    unlocks: [],
    tabStates: {},
    accruedFocusMs: 0,
    attemptDebounce: {},
    deferredBlockClaims: {},
    removedTabTombstones: {},
    scheduleUnavailableNoticeToken: null,
    handledScheduleOccurrences: [],
    enforcementEpoch,
    epochResetAcks: {},
    basePolicyRevision: 0,
    runtimeRevision: 0,
    documentCommands: {},
    enforcementCheckpoint: null,
    pendingEnforcementTransition: null,
    pendingClosure: null,
    date: localDateStr(now),
    todayAgg: null,
    lastPruneDate: null,
    commitCheckpoint: null,
  };
}

/**
 * The marker is exactly one field of exact plain data, so an extra key, an accessor, or any exotic
 * host object is not the marker.
 */
export function isRuntimeSchemaMarkerV2(value: unknown): value is RuntimeSchemaMarkerV2 {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(value);
  return snapshot !== null && isRuntimeSchemaMarkerValue(snapshot.value);
}

/**
 * The stored runtime is authority only when the v2 parser accepts it. Absence is not a v1 shape, so
 * an interrupted migration write or a partial local removal boots empty instead of rejecting, and a
 * value that mixes v1 and v2 keys is never accepted as either shape.
 *
 * This reads the marker alone. `marker-without-v2` therefore means only that a marker sits over a
 * runtime this reader cannot parse as v2. The spec's cutoff is conditional on the marker existing
 * *without a valid migration checkpoint*, so the caller owes the other half: resolve the stored
 * `LOCAL_RUNTIME_MIGRATION` checkpoint first and replay a valid one, and treat this verdict as the
 * refusal to migrate unversioned v1 again only when no valid checkpoint is there to replay.
 */
export function classifyStoredRuntime(
  raw: unknown,
  marker: RuntimeSchemaMarkerV2 | null,
): StoredRuntimeAuthority {
  const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(raw);
  if (runtime !== null) return { kind: 'v2', runtime };
  if (raw === undefined) return { kind: 'absent' };

  const snapshot: ExactDataSnapshot | null = snapshotExactData(raw);
  if (snapshot === null) return { kind: 'rejected', reason: 'invalid-v2', raw };
  if (isRecord(snapshot.value) && declaresV2Shape(snapshot.value)) {
    return { kind: 'rejected', reason: 'invalid-v2', raw };
  }
  if (marker !== null) return { kind: 'rejected', reason: 'marker-without-v2', raw };
  return { kind: 'legacy', raw };
}

export async function readRuntimeSchemaMarker(): Promise<RuntimeSchemaMarkerV2 | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_RUNTIME_SCHEMA);
  return isRuntimeSchemaMarkerV2(stored[LOCAL_RUNTIME_SCHEMA])
    ? { ...RUNTIME_SCHEMA_MARKER_V2 }
    : null;
}

/**
 * Resolves the committed policy generation pointer exactly like `loadRuntime`, so callers must run
 * this only after `policyStorage.initialize()` has settled that pointer.
 */
export async function loadRuntimeAuthority(): Promise<StoredRuntimeAuthority> {
  // The two reads are not atomic, so the marker comes first. A migration landing between them then
  // pairs a new runtime with an old marker, and a parseable v2 runtime wins before the marker is
  // consulted. The other order would pair an old runtime with a new marker and reject it.
  const marker: RuntimeSchemaMarkerV2 | null = await readRuntimeSchemaMarker();
  const raw: unknown = await readStoredRuntimeRaw();
  return classifyStoredRuntime(raw, marker);
}

export async function saveRuntimeV2(runtime: RuntimeStateV2): Promise<void> {
  const parsed: RuntimeStateV2 | null = parseRuntimeStateV2(runtime);
  if (parsed === null) {
    throw new CoreError('invalid-rule', 'runtime v2 failed validation before save');
  }
  await chrome.storage.local.set({ [LOCAL_RUNTIME]: parsed });
}

/** A stored value that names a schema version or carries a v2-only key is not unversioned v1. */
function declaresV2Shape(snapshot: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(snapshot, 'runtimeSchemaVersion') ||
    V2_ONLY_RUNTIME_KEYS.some((key: string): boolean => Object.hasOwn(snapshot, key))
  );
}
