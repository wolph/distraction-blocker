/**
 * The all-data clear journal: after the cutover it is the single durable deletion authority, and
 * Runtime, Setup, and the install marker are projections it owns rather than peer authorities.
 *
 * This is a neutral leaf. It holds the journal types, one exact parser, the legacy upgrade helper,
 * new journal creation, lifecycle-intent append, and the public read model. It imports neither
 * Main, Policy Storage, nor Engine, so every owner of a journal phase can call it while holding the
 * shared deletion lease. Nothing here reads or writes storage.
 */

import { CoreError } from '../shared/errors';
import { exactDataEqual, snapshotExactData } from '../shared/exact-data';
import { isInstallMarker, isSetupState } from '../shared/runtime-validation';
import type { InstallMarker, SetupState } from '../shared/types';
import {
  everyDenseEntry,
  exactRecord,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  isSafeTimestamp,
  isUuid,
} from '../shared/v2-domain-intrinsics';
import {
  detachedIdentityMap,
  validateDetachedCleanupEnforcementTarget,
  validateDetachedCleanupRetryState,
} from './cleanup-closure-v2-validation';
import { freshCleanupRetryStateV2 } from './cleanup-progress-v2';
import type { DocumentEpochResetAck, FrozenEpochResetCommand } from './enforcement-persistence-v2';
import {
  validateDetachedDocumentEpochResetAck,
  validateDetachedFrozenEpochResetCommand,
} from './enforcement-persistence-v2-validation';
import { emptyRuntimeV2 } from './runtime-store-v2';
import type {
  CleanupEnforcementTarget,
  CleanupRetryState,
  RuntimeStateV2,
} from './runtime-v2-types';
import { parseRuntimeStateV2 } from './runtime-v2-validation';

type UnknownRecord = Record<string, unknown>;

export const MAX_PENDING_INSTALL_LIFECYCLE_INTENTS: number = 64;
export const DATA_CLEAR_RESET_DEADLINE_MS: number = 10_000;
export const MAX_DATA_CLEAR_RESOLVER_PASSES: number = 3;

/** The retry error a full intent list records, so the failure is durable and visible. */
const INSTALL_LIFECYCLE_INTENT_CAPACITY_ERROR: string = 'install-lifecycle-intent-capacity';

export interface DataClearDeferredTarget {
  tabId: number;
  documentId: string | null;
  expectedUrl: string;
  reason: 'no-document-id' | 'no-receiver';
}

export interface DataClearResetExclusion {
  tabId: number;
  documentId: string | null;
  expectedUrl: string;
  reason: 'known-unsupported' | 'closed';
}

export interface DataClearResetProgress {
  attemptStartedAt: number | null;
  resolverPassCount: 0 | 1 | 2 | 3;
  targetGeneration: number | null;
  stablePasses: 0 | 1 | 2;
  targets: Record<string, CleanupEnforcementTarget>;
  commands: Record<string, FrozenEpochResetCommand>;
  acknowledgements: Record<string, DocumentEpochResetAck>;
  exclusions: DataClearResetExclusion[];
  deferredUnreachable: DataClearDeferredTarget[];
}

/** The exact current install marker schema, never a second marker format. */
export type InstallMarkerProjection = InstallMarker;

export interface CleanInstallMarkerProjection extends InstallMarkerProjection {
  profile: 'clean';
  latestReason: 'install';
}

export interface FinalInstallMarkerProjection extends InstallMarkerProjection {
  profile: 'clean';
}

export interface PendingInstallLifecycleIntent {
  version: 1;
  eventId: string;
  reason: 'install' | 'update' | 'chrome_update' | 'shared_module_update';
  currentVersion: string;
  previousVersion: string | null;
  observedAt: number;
}

export interface AllDataClearJournalV2 {
  version: 2;
  scope: 'all';
  phase: 'remote' | 'local' | 'browser-reset';
  inventory: string[];
  resetEpoch: string;
  resetOperationId: string;
  runtimeProjection: RuntimeStateV2 | null;
  setupProjection: SetupState | null;
  installMarkerProjection: CleanInstallMarkerProjection | null;
  finalInstallMarkerProjection: FinalInstallMarkerProjection | null;
  pendingInstallLifecycleIntents: PendingInstallLifecycleIntent[];
  resetProgress: DataClearResetProgress | null;
  retry: CleanupRetryState;
}

export interface SyncedPolicyClearJournal {
  scope: 'synced-policy';
  phase: 'remote' | 'local';
  inventory: string[];
}

export interface LocalHistoryClearJournal {
  scope: 'local-history';
  phase: 'local' | 'runtime';
  inventory: string[];
  clearAggregates: boolean;
  priorStorageError: SetupState['storageError'];
}

export type DataClearJournal =
  | AllDataClearJournalV2
  | SyncedPolicyClearJournal
  | LocalHistoryClearJournal;

export type AllDataClearPublicState =
  | { status: 'idle'; scope: null; phase: null }
  | {
      status: 'pending' | 'error';
      scope: 'all';
      phase: 'remote' | 'local' | 'browser-reset';
    };

/** Migration input only. Version 2 code never emits this shape. */
export interface LegacyAllDataClearJournal {
  scope: 'all';
  phase: 'remote' | 'local';
  inventory: string[];
}

export interface DataClearResetIdsV2 {
  resetEpoch: string;
  resetOperationId: string;
}

export type InstallLifecycleAppendResult = 'appended' | 'duplicate' | 'capacity';

const ALL_DATA_JOURNAL_KEYS: readonly string[] = [
  'version',
  'scope',
  'phase',
  'inventory',
  'resetEpoch',
  'resetOperationId',
  'runtimeProjection',
  'setupProjection',
  'installMarkerProjection',
  'finalInstallMarkerProjection',
  'pendingInstallLifecycleIntents',
  'resetProgress',
  'retry',
];
const RESET_PROGRESS_KEYS: readonly string[] = [
  'attemptStartedAt',
  'resolverPassCount',
  'targetGeneration',
  'stablePasses',
  'targets',
  'commands',
  'acknowledgements',
  'exclusions',
  'deferredUnreachable',
];
const RESET_TARGET_LIST_KEYS: readonly string[] = ['tabId', 'documentId', 'expectedUrl', 'reason'];
const INTENT_KEYS: readonly string[] = [
  'version',
  'eventId',
  'reason',
  'currentVersion',
  'previousVersion',
  'observedAt',
];
const THREE_KEY_JOURNAL_KEYS: readonly string[] = ['scope', 'phase', 'inventory'];
const LOCAL_HISTORY_KEYS: readonly string[] = ['scope', 'phase', 'inventory', 'clearAggregates'];
const LOCAL_HISTORY_KEYS_WITH_ERROR: readonly string[] = [
  ...LOCAL_HISTORY_KEYS,
  'priorStorageError',
];
const INSTALL_REASONS: ReadonlySet<string> = new Set<string>([
  'install',
  'update',
  'chrome_update',
  'shared_module_update',
]);
const DEFERRAL_REASONS: ReadonlySet<string> = new Set<string>(['no-document-id', 'no-receiver']);
const EXCLUSION_REASONS: ReadonlySet<string> = new Set<string>(['known-unsupported', 'closed']);
/** The builder's instant only fills `date`, which the cleared comparison replaces. */
const CLEARED_PROJECTION_INSTANT_MS: number = 0;
/**
 * Every storage error the setup record persists. The local-history clear copies the record's
 * value into its journal, so a code missing here strands the profile behind a journal the next
 * boot refuses. The two boot overlays are answered, never written, and stay out.
 */
const SETUP_STORAGE_ERRORS: ReadonlySet<string> = new Set<string>([
  'legacy-migration-failed',
  'sync-publish-failed',
  'remote-deletion-failed',
  'local-clear-failed',
  'legacy-remote-policy-dropped',
]);

/**
 * One root snapshot, then exact detached validation. Returns the version 2 all-data journal, the
 * current synced-policy or local-history journal, the legacy all-data shape the upgrade helper
 * accepts, or null. It never throws and never returns a value that aliases the stored one.
 */
export function parseDataClearJournal(
  value: unknown,
): DataClearJournal | LegacyAllDataClearJournal | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  if (!isRecord(snapshot)) return null;
  if (validateDetachedAllDataClearJournalV2(snapshot)) return snapshot;
  const threeKey: SyncedPolicyClearJournal | LegacyAllDataClearJournal | null =
    parseDetachedThreeKeyJournal(snapshot);
  return threeKey ?? parseDetachedLocalHistoryJournal(snapshot);
}

export function isLegacyAllDataClearJournal(
  value: DataClearJournal | LegacyAllDataClearJournal,
): value is LegacyAllDataClearJournal {
  return value.scope === 'all' && !('version' in value);
}

/**
 * The one accepted path from the legacy all-data shape to version 2. It preserves scope, phase, and
 * the current parser's stable first-occurrence inventory, and adds the fresh reset identity, null
 * projections, an empty intent list, and a fresh retry state. Version 2 input is returned unchanged.
 */
export function upgradeLegacyAllDataClearJournal(
  value: unknown,
  ids: DataClearResetIdsV2,
  at: number,
): AllDataClearJournalV2 {
  const parsed: DataClearJournal | LegacyAllDataClearJournal | null = parseDataClearJournal(value);
  if (parsed !== null && !isLegacyAllDataClearJournal(parsed) && parsed.scope === 'all') {
    return parsed;
  }
  if (parsed === null || !isLegacyAllDataClearJournal(parsed)) {
    invalidJournal('only an exact legacy all-data journal upgrades to version 2');
  }
  return validatedJournalV2({
    ...freshAllDataClearJournalV2(ids, at),
    phase: parsed.phase,
    inventory: parsed.inventory,
  });
}

export function createAllDataClearJournalV2(
  ids: DataClearResetIdsV2,
  at: number,
): AllDataClearJournalV2 {
  return validatedJournalV2(freshAllDataClearJournalV2(ids, at));
}

/**
 * Appends one captured lifecycle intent. An identical duplicate is an idempotent no-op, a
 * conflicting duplicate is invalid journal state, and a full list keeps every durable intent and
 * records the capacity failure in retry error state instead of evicting anything.
 */
export function appendInstallLifecycleIntent(
  journal: AllDataClearJournalV2,
  intent: PendingInstallLifecycleIntent,
): { journal: AllDataClearJournalV2; result: InstallLifecycleAppendResult } {
  const current: AllDataClearJournalV2 = detachedJournalV2(journal);
  const record: PendingInstallLifecycleIntent = detachedIntent(intent);
  const saved: PendingInstallLifecycleIntent | undefined =
    current.pendingInstallLifecycleIntents.find(
      (candidate: PendingInstallLifecycleIntent): boolean => candidate.eventId === record.eventId,
    );
  if (saved !== undefined) {
    if (!exactDataEqual(saved, record)) {
      invalidJournal('a duplicate lifecycle intent must carry identical data');
    }
    return { journal: current, result: 'duplicate' };
  }
  if (current.pendingInstallLifecycleIntents.length >= MAX_PENDING_INSTALL_LIFECYCLE_INTENTS) {
    return {
      journal: validatedJournalV2({
        ...current,
        retry: { ...current.retry, lastError: INSTALL_LIFECYCLE_INTENT_CAPACITY_ERROR },
      }),
      result: 'capacity',
    };
  }
  const pendingInstallLifecycleIntents: PendingInstallLifecycleIntent[] = [
    ...current.pendingInstallLifecycleIntents,
    record,
  ].sort(byObservedAtThenEventId);
  return {
    journal: validatedJournalV2({ ...current, pendingInstallLifecycleIntents }),
    result: 'appended',
  };
}

/** The all-data read model. Any all-data journal projects pending or error, never idle. */
export function projectAllDataClearPublicState(
  journal: DataClearJournal | null,
): AllDataClearPublicState {
  // The synced-policy and local-history journals keep their own public surface in Setup, so this
  // all-data read model reports idle for them rather than borrowing their phase.
  if (journal === null || journal.scope !== 'all') {
    return { status: 'idle', scope: null, phase: null };
  }
  const pending: boolean = journal.retry.lastError === null || journal.retry.nextAttemptAt !== null;
  return { status: pending ? 'pending' : 'error', scope: 'all', phase: journal.phase };
}

/**
 * The empty reset progress a journal carries when it enters browser reset, before the resolver has
 * started an attempt. Every producer builds it here so the nine-field shape has one definition.
 */
export function emptyDataClearResetProgress(): DataClearResetProgress {
  return {
    attemptStartedAt: null,
    resolverPassCount: 0,
    targetGeneration: null,
    stablePasses: 0,
    targets: {},
    commands: {},
    acknowledgements: {},
    exclusions: [],
    deferredUnreachable: [],
  };
}

/**
 * The one builder for the clean install-marker projection, so the exact literal the browser-reset
 * journal validates is never spelled a second time in a writer or in a test.
 */
export function cleanInstallMarkerProjection(
  extensionVersion: string,
): CleanInstallMarkerProjection {
  if (!isNonBlankString(extensionVersion)) {
    invalidJournal('a clean install marker projection needs a non-blank extension version');
  }
  return { version: 1, profile: 'clean', latestReason: 'install', extensionVersion };
}

/**
 * The exact marker transform replay applies for one intent. `previousVersion` is retained for event
 * recovery and never changes the current marker, which is the existing install-marker semantics.
 */
export function nextFinalMarkerProjection(
  journal: AllDataClearJournalV2,
  intent: PendingInstallLifecycleIntent,
): FinalInstallMarkerProjection {
  const current: FinalInstallMarkerProjection | null = journal.finalInstallMarkerProjection;
  if (current === null) invalidJournal('a marker transform needs a final marker projection');
  const record: PendingInstallLifecycleIntent = detachedIntent(intent);
  if (journal.pendingInstallLifecycleIntents[0]?.eventId !== record.eventId) {
    invalidJournal('a marker transform applies only to the first pending lifecycle intent');
  }
  const next: FinalInstallMarkerProjection = {
    ...current,
    latestReason: record.reason === 'update' ? 'update' : 'install',
    extensionVersion: record.currentVersion,
  };
  if (!validateDetachedFinalMarkerProjection(next)) {
    invalidJournal('a marker transform must leave a valid final marker projection');
  }
  return next;
}

function freshAllDataClearJournalV2(ids: DataClearResetIdsV2, at: number): AllDataClearJournalV2 {
  if (!isUuid(ids.resetEpoch) || !isUuid(ids.resetOperationId)) {
    invalidJournal('an all-data journal needs a fresh reset epoch and operation UUID');
  }
  if (!isSafeTimestamp(at)) invalidJournal('an all-data journal needs a safe creation instant');
  return {
    version: 2,
    scope: 'all',
    phase: 'remote',
    inventory: [],
    resetEpoch: ids.resetEpoch,
    resetOperationId: ids.resetOperationId,
    runtimeProjection: null,
    setupProjection: null,
    installMarkerProjection: null,
    finalInstallMarkerProjection: null,
    pendingInstallLifecycleIntents: [],
    resetProgress: null,
    retry: freshCleanupRetryStateV2(1, at),
  };
}

function byObservedAtThenEventId(
  left: PendingInstallLifecycleIntent,
  right: PendingInstallLifecycleIntent,
): number {
  if (left.observedAt !== right.observedAt) return left.observedAt - right.observedAt;
  return left.eventId === right.eventId ? 0 : left.eventId < right.eventId ? -1 : 1;
}

function detachedJournalV2(journal: AllDataClearJournalV2): AllDataClearJournalV2 {
  const snapshot: unknown = snapshotExactData(journal)?.value;
  if (!validateDetachedAllDataClearJournalV2(snapshot)) {
    invalidJournal('an all-data journal transform needs a valid journal');
  }
  return snapshot;
}

function detachedIntent(intent: PendingInstallLifecycleIntent): PendingInstallLifecycleIntent {
  const snapshot: unknown = snapshotExactData(intent)?.value;
  if (!validateDetachedInstallLifecycleIntent(snapshot)) {
    invalidJournal('a lifecycle intent must carry its exact captured fields');
  }
  return snapshot;
}

function validatedJournalV2(journal: AllDataClearJournalV2): AllDataClearJournalV2 {
  if (!validateDetachedAllDataClearJournalV2(journal)) {
    invalidJournal('an all-data journal transform must leave a valid journal');
  }
  return journal;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedAllDataClearJournalV2(value: unknown): value is AllDataClearJournalV2 {
  const candidate: UnknownRecord | null = exactRecord(value, ALL_DATA_JOURNAL_KEYS);
  const phase: unknown = candidate?.phase;
  const resetEpoch: unknown = candidate?.resetEpoch;
  if (
    candidate === null ||
    candidate.version !== 2 ||
    candidate.scope !== 'all' ||
    (phase !== 'remote' && phase !== 'local' && phase !== 'browser-reset') ||
    !isUuid(resetEpoch) ||
    !isUuid(candidate.resetOperationId) ||
    !validateDetachedInventory(candidate.inventory) ||
    (phase === 'browser-reset' && candidate.inventory.length > 0) ||
    !validateDetachedIntentList(candidate.pendingInstallLifecycleIntents) ||
    !validateDetachedCleanupRetryState(candidate.retry)
  ) {
    return false;
  }
  return phase === 'browser-reset'
    ? validateDetachedResetProjections(candidate, resetEpoch, candidate.resetOperationId)
    : nullBeforeBrowserReset(candidate);
}

/** Remote and local own deletion, so no projection and no reset progress exists yet. */
function nullBeforeBrowserReset(candidate: UnknownRecord): boolean {
  return (
    candidate.runtimeProjection === null &&
    candidate.setupProjection === null &&
    candidate.installMarkerProjection === null &&
    candidate.finalInstallMarkerProjection === null &&
    candidate.resetProgress === null
  );
}

/** Browser reset carries the complete durable projections the repair path replays from. */
function validateDetachedResetProjections(
  candidate: UnknownRecord,
  resetEpoch: string,
  resetOperationId: unknown,
): boolean {
  return (
    validateDetachedResetRuntimeProjection(candidate.runtimeProjection, resetEpoch) &&
    validateDetachedResetSetupProjection(candidate.setupProjection) &&
    validateDetachedCleanMarkerProjection(candidate.installMarkerProjection) &&
    validateDetachedFinalMarkerProjection(candidate.finalInstallMarkerProjection) &&
    validateDetachedResetProgress(candidate.resetProgress, resetEpoch, resetOperationId)
  );
}

/** The projected runtime is a fresh clean runtime under the reset epoch, with nothing published. */
function validateDetachedResetRuntimeProjection(
  value: unknown,
  resetEpoch: string,
): value is RuntimeStateV2 {
  const runtime: RuntimeStateV2 | null = parseRuntimeStateV2(value);
  return runtime !== null && isClearedRuntimeProjection(runtime, resetEpoch);
}

/**
 * Spec line 1317: the runtime projection "contains no user history, uses `resetEpoch` as
 * `enforcementEpoch`, has zero base and runtime revisions, and has empty reset acknowledgements and
 * document commands". A cleared projection is therefore exactly the idle runtime a clean install
 * boots from, under the reset epoch, so it is compared against `emptyRuntimeV2` itself rather than
 * against a second field list that could drift from the value the producer writes.
 *
 * `date` is the only field the projection carries. It is the local day the clear advanced, and a
 * stored-value parser has no clock to recompute it, so the runtime's own day is substituted before
 * the comparison. Every other field, including `todayAgg` blocked-host counts, `unlocks`,
 * `attemptDebounce`, `tabStates`, `gate`, and `lastPruneDate`, must be at its empty value.
 */
function isClearedRuntimeProjection(runtime: RuntimeStateV2, resetEpoch: string): boolean {
  const cleared: RuntimeStateV2 = {
    ...emptyRuntimeV2(CLEARED_PROJECTION_INSTANT_MS, resetEpoch),
    date: runtime.date,
  };
  return exactDataEqual(runtime, cleared);
}

/**
 * Spec line 1317: the Setup projection is "the final clean Setup with idle `dataClear`". A stored
 * projection that still reports a clear in progress, or a retained storage error, would be
 * materialized as the post-clear Setup and leave the UI reporting a clear no journal can finish.
 */
function validateDetachedResetSetupProjection(value: unknown): value is SetupState {
  if (!isSetupState(value)) return false;
  return (
    value.storageError === null &&
    value.dataClear.status === 'idle' &&
    value.dataClear.scope === null &&
    value.dataClear.phase === null
  );
}

function validateDetachedCleanMarkerProjection(
  value: unknown,
): value is CleanInstallMarkerProjection {
  return isInstallMarker(value) && value.profile === 'clean' && value.latestReason === 'install';
}

function validateDetachedFinalMarkerProjection(
  value: unknown,
): value is FinalInstallMarkerProjection {
  return isInstallMarker(value) && value.profile === 'clean';
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedResetProgress(
  value: unknown,
  resetEpoch: string,
  resetOperationId: unknown,
): value is DataClearResetProgress {
  const candidate: UnknownRecord | null = exactRecord(value, RESET_PROGRESS_KEYS);
  const attemptStartedAt: unknown = candidate?.attemptStartedAt;
  const resolverPassCount: unknown = candidate?.resolverPassCount;
  const targetGeneration: unknown = candidate?.targetGeneration;
  if (
    candidate === null ||
    (attemptStartedAt !== null && !isSafeTimestamp(attemptStartedAt)) ||
    !isBoundedCount(resolverPassCount, MAX_DATA_CLEAR_RESOLVER_PASSES) ||
    (attemptStartedAt === null && resolverPassCount !== 0) ||
    (targetGeneration !== null && !isNonNegativeInteger(targetGeneration)) ||
    !isBoundedCount(candidate.stablePasses, 2) ||
    !everyDenseEntry(candidate.exclusions, validateDetachedResetExclusion) ||
    !everyDenseEntry(candidate.deferredUnreachable, validateDetachedDeferredTarget)
  ) {
    return false;
  }
  const targets: Record<string, CleanupEnforcementTarget> | null = detachedIdentityMap(
    candidate.targets,
    validateDetachedCleanupEnforcementTarget,
  );
  const commands: Record<string, FrozenEpochResetCommand> | null = detachedIdentityMap(
    candidate.commands,
    validateDetachedFrozenEpochResetCommand,
  );
  const acknowledgements: Record<string, DocumentEpochResetAck> | null = detachedIdentityMap(
    candidate.acknowledgements,
    validateDetachedDocumentEpochResetAck,
  );
  if (targets === null || commands === null || acknowledgements === null) return false;
  return resetCommandsAgree({ targets, commands, acknowledgements }, resetEpoch, resetOperationId);
}

interface DetachedResetMapsV2 {
  targets: Record<string, CleanupEnforcementTarget>;
  commands: Record<string, FrozenEpochResetCommand>;
  acknowledgements: Record<string, DocumentEpochResetAck>;
}

/**
 * One frozen command per target under this journal's reset identity, and an acknowledgement only
 * where a target exists. The identity map already proved every key is its entry's identity.
 */
function resetCommandsAgree(
  maps: DetachedResetMapsV2,
  resetEpoch: string,
  resetOperationId: unknown,
): boolean {
  const keys: string[] = Object.keys(maps.targets);
  if (keys.length !== Object.keys(maps.commands).length) return false;
  const matched: boolean = keys.every((key: string): boolean => {
    const target: CleanupEnforcementTarget | undefined = maps.targets[key];
    const command: FrozenEpochResetCommand | undefined = maps.commands[key];
    if (target === undefined || command === undefined) return false;
    return (
      command.operationId === resetOperationId &&
      command.enforcementEpoch === resetEpoch &&
      command.tabId === target.tabId &&
      command.documentId === target.documentId &&
      command.expectedUrl === target.expectedUrl
    );
  });
  return (
    matched &&
    Object.keys(maps.acknowledgements).every((key: string): boolean =>
      Object.hasOwn(maps.targets, key),
    )
  );
}

function validateDetachedResetExclusion(value: unknown): value is DataClearResetExclusion {
  const candidate: UnknownRecord | null = exactRecord(value, RESET_TARGET_LIST_KEYS);
  return (
    candidate !== null &&
    isKeyedResetTarget(candidate) &&
    typeof candidate.reason === 'string' &&
    EXCLUSION_REASONS.has(candidate.reason)
  );
}

function validateDetachedDeferredTarget(value: unknown): value is DataClearDeferredTarget {
  const candidate: UnknownRecord | null = exactRecord(value, RESET_TARGET_LIST_KEYS);
  return (
    candidate !== null &&
    isKeyedResetTarget(candidate) &&
    typeof candidate.reason === 'string' &&
    DEFERRAL_REASONS.has(candidate.reason)
  );
}

/** A recorded target keeps its tab and URL, and may have lost its document ID. */
function isKeyedResetTarget(candidate: UnknownRecord): boolean {
  return (
    isNonNegativeInteger(candidate.tabId) &&
    (candidate.documentId === null || isNonBlankString(candidate.documentId)) &&
    isNonBlankString(candidate.expectedUrl)
  );
}

function validateDetachedInventory(value: unknown): value is string[] {
  return everyDenseEntry(value, isNonBlankString) && new Set(value).size === value.length;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedIntentList(value: unknown): value is PendingInstallLifecycleIntent[] {
  if (
    !everyDenseEntry(value, validateDetachedInstallLifecycleIntent) ||
    value.length > MAX_PENDING_INSTALL_LIFECYCLE_INTENTS
  ) {
    return false;
  }
  const ids: Set<string> = new Set<string>(
    value.map((intent: PendingInstallLifecycleIntent): string => intent.eventId),
  );
  return ids.size === value.length && isIntentOrder(value);
}

/** Sorted by observation instant and then event ID, which makes replay order deterministic. */
function isIntentOrder(intents: readonly PendingInstallLifecycleIntent[]): boolean {
  for (let index: number = 1; index < intents.length; index++) {
    const previous: PendingInstallLifecycleIntent | undefined = intents[index - 1];
    const current: PendingInstallLifecycleIntent | undefined = intents[index];
    if (previous === undefined || current === undefined) return false;
    if (byObservedAtThenEventId(previous, current) >= 0) return false;
  }
  return true;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
function validateDetachedInstallLifecycleIntent(
  value: unknown,
): value is PendingInstallLifecycleIntent {
  const candidate: UnknownRecord | null = exactRecord(value, INTENT_KEYS);
  const reason: unknown = candidate?.reason;
  return (
    candidate !== null &&
    candidate.version === 1 &&
    isUuid(candidate.eventId) &&
    typeof reason === 'string' &&
    INSTALL_REASONS.has(reason) &&
    isNonBlankString(candidate.currentVersion) &&
    (candidate.previousVersion === null || isNonBlankString(candidate.previousVersion)) &&
    isSafeTimestamp(candidate.observedAt)
  );
}

/**
 * The current three-key shape. Scope `all` is legacy migration input, scope `synced-policy` is a
 * live journal. Both keep the current parser's stable first-occurrence inventory.
 */
function parseDetachedThreeKeyJournal(
  candidate: UnknownRecord,
): SyncedPolicyClearJournal | LegacyAllDataClearJournal | null {
  const scope: unknown = candidate.scope;
  const phase: unknown = candidate.phase;
  if (
    exactRecord(candidate, THREE_KEY_JOURNAL_KEYS) === null ||
    (scope !== 'all' && scope !== 'synced-policy') ||
    (phase !== 'remote' && phase !== 'local') ||
    !everyDenseEntry(candidate.inventory, isJournalKey)
  ) {
    return null;
  }
  return { scope, phase, inventory: [...new Set(candidate.inventory)] };
}

/** The current local-history shape, including the older value that omits `priorStorageError`. */
function parseDetachedLocalHistoryJournal(
  candidate: UnknownRecord,
): LocalHistoryClearJournal | null {
  const phase: unknown = candidate.phase;
  const priorStorageError: unknown = candidate.priorStorageError;
  if (
    (exactRecord(candidate, LOCAL_HISTORY_KEYS) === null &&
      exactRecord(candidate, LOCAL_HISTORY_KEYS_WITH_ERROR) === null) ||
    candidate.scope !== 'local-history' ||
    (phase !== 'local' && phase !== 'runtime') ||
    !everyDenseEntry(candidate.inventory, isJournalKey) ||
    typeof candidate.clearAggregates !== 'boolean' ||
    !(priorStorageError === undefined || isSetupStorageError(priorStorageError))
  ) {
    return null;
  }
  return {
    scope: 'local-history',
    phase,
    inventory: [...new Set(candidate.inventory)],
    clearAggregates: candidate.clearAggregates,
    priorStorageError: isSetupStorageError(priorStorageError) ? priorStorageError : null,
  };
}

function isSetupStorageError(value: unknown): value is SetupState['storageError'] {
  return value === null || (typeof value === 'string' && SETUP_STORAGE_ERRORS.has(value));
}

function isJournalKey(value: unknown): value is string {
  return typeof value === 'string';
}

function isBoundedCount<T extends number>(value: unknown, maximum: number): value is T {
  return isNonNegativeInteger(value) && value <= maximum;
}

function invalidJournal(message: string): never {
  throw new CoreError('invalid-rule', message);
}
