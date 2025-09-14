import { parseDailyAgg } from '../core/stats';
import { exactDataEqual, snapshotExactData } from '../shared/exact-data';
import { isEventRecord, isSessionEndedEventV2 } from '../shared/runtime-validation';
import type {
  BankState,
  DailyAgg,
  HandledScheduleOccurrence,
  LegacyEventRecord,
  SessionEndedEventV2,
} from '../shared/types';
import {
  everyDenseEntry,
  exactRecord,
  isDenseArray,
  isNonBlankString,
  isNonNegativeInteger,
  isRecord,
  isSafeTimestamp,
  isUuid,
  validateDetachedScheduleOccurrenceRef,
} from '../shared/v2-domain-intrinsics';
import type { FrozenDocumentCommand } from './enforcement-persistence-v2';
import { validateDetachedFrozenDocumentCommand } from './enforcement-persistence-v2-validation';
import type { RuntimeTabState } from './runtime-leaf-types';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
  ClosureProjection,
  PendingClosure,
  PostCleanupClosure,
} from './runtime-v2-types';

type UnknownRecord = Record<string, unknown>;

/** The stored operation authority every clear command in one cleanup batch repeats. */
interface ClearBatchHeader {
  cleanupOperationId: string;
  clearRuntimeRevision: number;
}

const MAX_AUTOMATIC_CLEANUP_ATTEMPT: number = 12;
const HANDLED_OCCURRENCE_TTL_MS: number = 14 * 24 * 60 * 60 * 1000;
const RETRY_KEYS: readonly string[] = ['batch', 'automaticAttempt', 'nextAttemptAt', 'lastError'];
const TAB_CLAIM_KEYS: readonly string[] = ['tabId', 'state'];
const TAB_STATE_KEYS: readonly string[] = ['muteUrl', 'priorMuted', 'stoppedDocumentId'];
const SEED_KEYS: readonly string[] = ['alarmNames', 'tabClaims'];
const TARGET_KEYS: readonly string[] = ['tabId', 'documentId', 'expectedUrl'];
const PROGRESS_KEYS: readonly string[] = [
  'cleanupOperationId',
  'clearRuntimeRevision',
  'targets',
  'clearCommands',
  'tabClaims',
  'resolvedTabIds',
  'retry',
];
const PROJECTION_KEYS: readonly string[] = [
  'closureId',
  'sessionId',
  'endedAt',
  'reason',
  'outcome',
  'focusedMs',
  'endEvent',
  'events',
  'handledOccurrences',
  'completionIncrement',
  'bankAfter',
  'aggregateSets',
  'aggregateRemoves',
];
const PENDING_CLOSURE_KEYS: readonly string[] = [
  'version',
  'stage',
  'projection',
  'cleanupSeed',
  'cleanupProgress',
];
const POST_CLEANUP_CLOSURE_KEYS: readonly string[] = ['projection', 'cleanupSeed'];
const HANDLED_OCCURRENCE_KEYS: readonly string[] = [
  'version',
  'token',
  'entryId',
  'localStartDate',
  'handledAt',
  'reason',
  'expiresAt',
];
const BANK_KEYS: readonly string[] = ['balanceMs'];
const DAILY_AGG_REQUIRED_KEYS: readonly string[] = [
  'date',
  'focusMs',
  'sessionsStarted',
  'sessionsCompleted',
  'attempts',
  'attemptsOther',
  'pausesTaken',
  'pauseMsSpent',
  'unlocksTaken',
  'resisted',
];
const DAILY_AGG_OPTIONAL_KEYS: readonly string[] = ['pauseMsEarned', 'unlockMsSpent'];
const AGGREGATE_SET_KEY_RE: RegExp = /^agg:[^:]+:(\d{4}-\d{2}-\d{2})$/;
const ARCHIVE_AGGREGATE_KEY_RE: RegExp =
  /^archive:clock-rebase:[^:]+:(\d{4}-\d{2}-\d{2}):\d+:[^:]+$/;
/** Required keys per legacy event variant. `sessionId` is optional on every variant that omits it. */
const LEGACY_EVENT_KEYS: ReadonlyMap<string, readonly string[]> = new Map<
  string,
  readonly string[]
>([
  ['sessionStarted', ['t', 'at', 'source', 'mode', 'strictness', 'durationMin', 'intention']],
  ['sessionCompleted', ['t', 'at', 'focusedMs']],
  ['sessionCanceled', ['t', 'at', 'focusedMs']],
  ['sessionIdentityAssigned', ['t', 'at', 'startedAt', 'sessionId']],
  ['phase', ['t', 'at', 'from', 'to']],
  ['attempt', ['t', 'at', 'url', 'host', 'tabId', 'kind']],
  ['gateOpened', ['t', 'at', 'gate']],
  ['gateResisted', ['t', 'at', 'gate']],
  ['budgetEarned', ['t', 'at', 'ms']],
  ['pauseTaken', ['t', 'at', 'ms']],
  ['unlockTaken', ['t', 'at', 'host', 'ms']],
]);
const HANDLED_OCCURRENCE_REASONS: ReadonlySet<string> = new Set<string>([
  'started',
  'closure-overlap',
]);

export function parseCleanupRetryState(value: unknown): CleanupRetryState | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedCleanupRetryState(snapshot) ? snapshot : null;
}

export function parseCleanupTabClaim(value: unknown): CleanupTabClaim | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedCleanupTabClaim(snapshot) ? snapshot : null;
}

export function parseCleanupSeed(value: unknown): CleanupSeed | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedCleanupSeed(snapshot) ? snapshot : null;
}

export function parseCleanupEnforcementTarget(value: unknown): CleanupEnforcementTarget | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedCleanupEnforcementTarget(snapshot) ? snapshot : null;
}

export function parseCleanupProgress(value: unknown): CleanupProgress | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedCleanupProgress(snapshot) ? snapshot : null;
}

export function parseClosureProjection(value: unknown): ClosureProjection | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedClosureProjection(snapshot) ? snapshot : null;
}

export function parsePostCleanupClosure(value: unknown): PostCleanupClosure | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedPostCleanupClosure(snapshot) ? snapshot : null;
}

export function parsePendingClosure(value: unknown): PendingClosure | null {
  const snapshot: unknown = snapshotExactData(value)?.value;
  return validateDetachedPendingClosure(snapshot) ? snapshot : null;
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. Each batch schedules its
 * next automatic attempt until the twelfth, which is the exhausted state that stops scheduling.
 */
export function validateDetachedCleanupRetryState(value: unknown): value is CleanupRetryState {
  const candidate: UnknownRecord | null = exactRecord(value, RETRY_KEYS);
  const automaticAttempt: unknown = candidate?.automaticAttempt;
  if (
    candidate === null ||
    !isNonNegativeInteger(candidate.batch) ||
    !isNonNegativeInteger(automaticAttempt) ||
    automaticAttempt > MAX_AUTOMATIC_CLEANUP_ATTEMPT ||
    (candidate.lastError !== null && !isNonBlankString(candidate.lastError))
  ) {
    return false;
  }
  return automaticAttempt === MAX_AUTOMATIC_CLEANUP_ATTEMPT
    ? candidate.nextAttemptAt === null
    : isSafeTimestamp(candidate.nextAttemptAt);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedRuntimeTabState(value: unknown): value is RuntimeTabState {
  const candidate: UnknownRecord | null = exactRecord(value, TAB_STATE_KEYS);
  return (
    candidate !== null &&
    isNullableNonBlankString(candidate.muteUrl) &&
    (candidate.priorMuted === null || typeof candidate.priorMuted === 'boolean') &&
    isNullableNonBlankString(candidate.stoppedDocumentId)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedCleanupTabClaim(value: unknown): value is CleanupTabClaim {
  const candidate: UnknownRecord | null = exactRecord(value, TAB_CLAIM_KEYS);
  return (
    candidate !== null &&
    isNonNegativeInteger(candidate.tabId) &&
    validateDetachedRuntimeTabState(candidate.state)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedCleanupSeed(value: unknown): value is CleanupSeed {
  const candidate: UnknownRecord | null = exactRecord(value, SEED_KEYS);
  return (
    candidate !== null &&
    everyDenseEntry(candidate.alarmNames, isNonBlankString) &&
    validateDetachedTabClaims(candidate.tabClaims)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedCleanupEnforcementTarget(
  value: unknown,
): value is CleanupEnforcementTarget {
  const candidate: UnknownRecord | null = exactRecord(value, TARGET_KEYS);
  return (
    candidate !== null &&
    isNonNegativeInteger(candidate.tabId) &&
    isNonBlankString(candidate.documentId) &&
    isNonBlankString(candidate.expectedUrl)
  );
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. This validates one stored
 * batch against itself. Comparing a retry with its predecessor belongs to the transition API.
 */
export function validateDetachedCleanupProgress(value: unknown): value is CleanupProgress {
  const candidate: UnknownRecord | null = exactRecord(value, PROGRESS_KEYS);
  const cleanupOperationId: unknown = candidate?.cleanupOperationId;
  const clearRuntimeRevision: unknown = candidate?.clearRuntimeRevision;
  if (
    candidate === null ||
    !isUuid(cleanupOperationId) ||
    !isNonNegativeInteger(clearRuntimeRevision) ||
    !validateDetachedTabClaims(candidate.tabClaims) ||
    !validateDetachedResolvedTabIds(candidate.resolvedTabIds) ||
    !validateDetachedCleanupRetryState(candidate.retry)
  ) {
    return false;
  }
  const targets: Record<string, CleanupEnforcementTarget> | null = detachedIdentityMap(
    candidate.targets,
    validateDetachedCleanupEnforcementTarget,
  );
  const clearCommands: Record<string, FrozenDocumentCommand> | null = detachedIdentityMap(
    candidate.clearCommands,
    validateDetachedFrozenDocumentCommand,
  );
  if (targets === null || clearCommands === null) return false;
  return clearBatchAgrees({ cleanupOperationId, clearRuntimeRevision }, targets, clearCommands);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedBankState(value: unknown): value is BankState {
  const candidate: UnknownRecord | null = exactRecord(value, BANK_KEYS);
  const balanceMs: unknown = candidate?.balanceMs;
  return typeof balanceMs === 'number' && Number.isFinite(balanceMs) && balanceMs >= 0;
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedHandledScheduleOccurrence(
  value: unknown,
): value is HandledScheduleOccurrence {
  const candidate: UnknownRecord | null = exactRecord(value, HANDLED_OCCURRENCE_KEYS);
  const handledAt: unknown = candidate?.handledAt;
  if (
    candidate === null ||
    !isSafeTimestamp(handledAt) ||
    typeof candidate.reason !== 'string' ||
    !HANDLED_OCCURRENCE_REASONS.has(candidate.reason) ||
    !isSafeTimestamp(candidate.expiresAt) ||
    candidate.expiresAt !== handledAt + HANDLED_OCCURRENCE_TTL_MS
  ) {
    return false;
  }
  return validateDetachedScheduleOccurrenceRef({
    version: candidate.version,
    token: candidate.token,
    entryId: candidate.entryId,
    localStartDate: candidate.localStartDate,
  });
}

/** Accepts only already-detached exact plain data keyed by the existing daily aggregate keys. */
export function validateDetachedAggregateSets(value: unknown): value is Record<string, DailyAgg> {
  const entries: Array<[string, unknown]> | null = detachedStringKeyEntries(value);
  if (entries === null) return false;
  return entries.every(([key, entry]: [string, unknown]): boolean => {
    const date: string | null = aggregateKeyDate(key);
    return date !== null && validateDetachedDailyAgg(entry, date);
  });
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedAggregateRemoves(value: unknown): value is string[] {
  return everyDenseEntry(value, isAggregateRemoveKey);
}

/**
 * Accepts only already-detached exact plain data from snapshotExactData. The projection is the
 * immutable logical end, so it carries no cleanup operation, claim, resolved ID, or retry field.
 */
export function validateDetachedClosureProjection(value: unknown): value is ClosureProjection {
  const candidate: UnknownRecord | null = exactRecord(value, PROJECTION_KEYS);
  const sessionId: unknown = candidate?.sessionId;
  const endEvent: unknown = candidate?.endEvent;
  const handledOccurrences: unknown = candidate?.handledOccurrences;
  if (
    candidate === null ||
    !isUuid(sessionId) ||
    candidate.closureId !== `${sessionId}:close` ||
    !isSafeTimestamp(candidate.endedAt) ||
    !isSafeTimestamp(candidate.focusedMs) ||
    !isSessionEndedEventV2(endEvent) ||
    !endEventRepeatsProjection(endEvent, candidate) ||
    !validateDetachedSettlementEvents(candidate.events, endEvent) ||
    !everyDenseEntry(handledOccurrences, validateDetachedHandledScheduleOccurrence) ||
    !hasUniqueOccurrenceTokens(handledOccurrences) ||
    !validateDetachedBankState(candidate.bankAfter) ||
    !validateDetachedAggregateSets(candidate.aggregateSets) ||
    !validateDetachedAggregateRemoves(candidate.aggregateRemoves)
  ) {
    return false;
  }
  return candidate.completionIncrement === (endEvent.outcome === 'completed' ? 1 : 0);
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedPostCleanupClosure(value: unknown): value is PostCleanupClosure {
  const candidate: UnknownRecord | null = exactRecord(value, POST_CLEANUP_CLOSURE_KEYS);
  return (
    candidate !== null &&
    validateDetachedClosureProjection(candidate.projection) &&
    validateDetachedCleanupSeed(candidate.cleanupSeed)
  );
}

/** Accepts only already-detached exact plain data from snapshotExactData. */
export function validateDetachedPendingClosure(value: unknown): value is PendingClosure {
  const candidate: UnknownRecord | null = exactRecord(value, PENDING_CLOSURE_KEYS);
  const projection: unknown = candidate?.projection;
  const cleanupSeed: unknown = candidate?.cleanupSeed;
  const cleanupProgress: unknown = candidate?.cleanupProgress;
  if (
    candidate === null ||
    candidate.version !== 1 ||
    !validateDetachedClosureProjection(projection) ||
    !validateDetachedCleanupSeed(cleanupSeed)
  ) {
    return false;
  }
  if (candidate.stage === 'prepared') return cleanupProgress === null;
  if (candidate.stage !== 'cleanup' || !validateDetachedCleanupProgress(cleanupProgress)) {
    return false;
  }
  return (
    cleanupProgressContinuesSeed(cleanupSeed, cleanupProgress) &&
    clearsClosedSession(cleanupProgress, projection.sessionId)
  );
}

/** Claims are one authoritative record per tab, stored in tab order so retries stay deterministic. */
function validateDetachedTabClaims(value: unknown): value is CleanupTabClaim[] {
  if (!everyDenseEntry(value, validateDetachedCleanupTabClaim)) return false;
  return isAscending(value.map((claim: CleanupTabClaim): number => claim.tabId));
}

function validateDetachedResolvedTabIds(value: unknown): value is number[] {
  return everyDenseEntry(value, isNonNegativeInteger) && isAscending(value);
}

/** Strictly ascending covers both required properties: unique entries in tab order. */
function isAscending(values: readonly number[]): boolean {
  for (let index: number = 1; index < values.length; index++) {
    const previous: number | undefined = values[index - 1];
    const current: number | undefined = values[index];
    if (previous === undefined || current === undefined || current <= previous) return false;
  }
  return true;
}

/** Returns the detached map when every key is exactly the identity of the entry it stores. */
function detachedIdentityMap<T extends { tabId: number; documentId: string }>(
  value: unknown,
  validateEntry: (entry: unknown) => entry is T,
): Record<string, T> | null {
  const entries: Array<[string, unknown]> | null = detachedStringKeyEntries(value);
  if (entries === null) return null;
  const map: Record<string, T> = {};
  for (const [key, entry] of entries) {
    if (!validateEntry(entry) || key !== documentIdentity(entry.tabId, entry.documentId)) {
      return null;
    }
    map[key] = entry;
  }
  return map;
}

function detachedStringKeyEntries(value: unknown): Array<[string, unknown]> | null {
  if (!isRecord(value)) return null;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  if (keys.some((key: PropertyKey): boolean => typeof key !== 'string')) return null;
  return keys.map((key: PropertyKey): [string, unknown] => [key as string, value[key as string]]);
}

/**
 * One stored batch clears exactly its own targets. Every command repeats the batch operation and
 * clear revision, clears its target document and URL, and shares one epoch and session identity.
 */
function clearBatchAgrees(
  header: ClearBatchHeader,
  targets: Record<string, CleanupEnforcementTarget>,
  clearCommands: Record<string, FrozenDocumentCommand>,
): boolean {
  const keys: string[] = Object.keys(targets);
  if (keys.length !== Object.keys(clearCommands).length) return false;
  const reference: FrozenDocumentCommand | undefined = clearCommands[keys[0] ?? ''];
  return keys.every((key: string): boolean => {
    const target: CleanupEnforcementTarget | undefined = targets[key];
    const command: FrozenDocumentCommand | undefined = clearCommands[key];
    if (target === undefined || command === undefined || reference === undefined) return false;
    return (
      clearsTarget(command, target, header) &&
      command.enforcementEpoch === reference.enforcementEpoch &&
      command.sessionId === reference.sessionId &&
      command.reservedSessionId === reference.reservedSessionId
    );
  });
}

function clearsTarget(
  command: FrozenDocumentCommand,
  target: CleanupEnforcementTarget,
  header: ClearBatchHeader,
): boolean {
  return (
    command.operationId === header.cleanupOperationId &&
    command.runtimeRevision === header.clearRuntimeRevision &&
    command.presentation === 'clear' &&
    command.overlay === null &&
    command.tabId === target.tabId &&
    command.documentId === target.documentId &&
    command.expectedUrl === target.expectedUrl
  );
}

/** Progress starts from the seed claims and may only fill an ownership field the seed left null. */
function cleanupProgressContinuesSeed(seed: CleanupSeed, progress: CleanupProgress): boolean {
  const claimed: Map<number, RuntimeTabState> = new Map<number, RuntimeTabState>(
    progress.tabClaims.map((claim: CleanupTabClaim): [number, RuntimeTabState] => [
      claim.tabId,
      claim.state,
    ]),
  );
  return seed.tabClaims.every((claim: CleanupTabClaim): boolean => {
    const current: RuntimeTabState | undefined = claimed.get(claim.tabId);
    return current !== undefined && continuesTabState(claim.state, current);
  });
}

function continuesTabState(seedState: RuntimeTabState, progressState: RuntimeTabState): boolean {
  return (
    (seedState.muteUrl === null || seedState.muteUrl === progressState.muteUrl) &&
    (seedState.priorMuted === null || seedState.priorMuted === progressState.priorMuted) &&
    (seedState.stoppedDocumentId === null ||
      seedState.stoppedDocumentId === progressState.stoppedDocumentId)
  );
}

/** A closure only ever clears a session that was durably committed, never a reserved identity. */
function clearsClosedSession(progress: CleanupProgress, sessionId: string): boolean {
  return Object.values(progress.clearCommands).every(
    (command: FrozenDocumentCommand): boolean => command.sessionId === sessionId,
  );
}

function endEventRepeatsProjection(
  endEvent: SessionEndedEventV2,
  projection: UnknownRecord,
): boolean {
  return (
    endEvent.sessionId === projection.sessionId &&
    endEvent.at === projection.endedAt &&
    endEvent.reason === projection.reason &&
    endEvent.outcome === projection.outcome &&
    endEvent.focusedMs === projection.focusedMs
  );
}

/** The settled events come first and the immutable end event closes the list exactly once. */
function validateDetachedSettlementEvents(value: unknown, endEvent: SessionEndedEventV2): boolean {
  if (!isDenseArray(value) || value.length === 0) return false;
  if (!exactDataEqual(value[value.length - 1], endEvent)) return false;
  return value
    .slice(0, -1)
    .every((event: unknown): boolean => validateDetachedLegacyEventRecord(event));
}

/** Legacy events keep their v1 domain and gain the exact-key rejection the v2 schemas require. */
function validateDetachedLegacyEventRecord(value: unknown): value is LegacyEventRecord {
  if (!isRecord(value) || typeof value.t !== 'string') return false;
  const required: readonly string[] | undefined = LEGACY_EVENT_KEYS.get(value.t);
  if (required === undefined) return false;
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  const allowed: boolean = keys.every(
    (key: PropertyKey): boolean =>
      typeof key === 'string' && (required.includes(key) || key === 'sessionId'),
  );
  return (
    allowed &&
    required.every((key: string): boolean => Object.hasOwn(value, key)) &&
    isEventRecord(value)
  );
}

function hasUniqueOccurrenceTokens(occurrences: readonly HandledScheduleOccurrence[]): boolean {
  const tokens: Set<string> = new Set<string>(
    occurrences.map((occurrence: HandledScheduleOccurrence): string => occurrence.token),
  );
  return tokens.size === occurrences.length;
}

function validateDetachedDailyAgg(value: unknown, date: string): value is DailyAgg {
  if (!isRecord(value) || !hasDailyAggKeys(value)) return false;
  return parseDailyAgg(value, date) !== null;
}

function hasDailyAggKeys(value: UnknownRecord): boolean {
  const keys: PropertyKey[] = Reflect.ownKeys(value);
  return (
    keys.every(
      (key: PropertyKey): boolean =>
        typeof key === 'string' &&
        (DAILY_AGG_REQUIRED_KEYS.includes(key) || DAILY_AGG_OPTIONAL_KEYS.includes(key)),
    ) && DAILY_AGG_REQUIRED_KEYS.every((key: string): boolean => Object.hasOwn(value, key))
  );
}

function aggregateKeyDate(key: string): string | null {
  return AGGREGATE_SET_KEY_RE.exec(key)?.[1] ?? ARCHIVE_AGGREGATE_KEY_RE.exec(key)?.[1] ?? null;
}

function isAggregateRemoveKey(value: unknown): value is string {
  return typeof value === 'string' && AGGREGATE_SET_KEY_RE.test(value);
}

function documentIdentity(tabId: number, documentId: string): string {
  return `${tabId}:${documentId}`;
}

function isNullableNonBlankString(value: unknown): value is string | null {
  return value === null || isNonBlankString(value);
}
