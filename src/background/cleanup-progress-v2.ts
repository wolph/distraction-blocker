/**
 * Pure builders for one cleanup batch: the 12-attempt retry schedule, the frozen clear commands, the
 * immutable seed, and the mutable progress record. Nothing here touches storage or a browser API.
 *
 * Every builder validates what it produces with the landed detached validators, so a value this
 * module returns is always a value the storage boundary accepts. A value that cannot satisfy the
 * contract raises `CoreError('invalid-rule', ...)` instead of reaching a caller.
 */

import { CLEANUP_MAX_AUTOMATIC_ATTEMPTS } from '../shared/constants';
import {
  CANONICAL_CLEAR_VERDICT,
  canonicalSessionIdentity,
} from '../shared/enforcement-v2-validation';
import { CoreError } from '../shared/errors';
import { type ExactDataSnapshot, snapshotExactData } from '../shared/exact-data';
import type { Verdict } from '../shared/types';
import {
  isNonBlankString,
  isNonNegativeInteger,
  isSafeTimestamp,
} from '../shared/v2-domain-intrinsics';
import {
  validateDetachedCleanupProgress,
  validateDetachedCleanupRetryState,
  validateDetachedCleanupSeed,
  validateDetachedCleanupTabClaim,
  validateDetachedRuntimeTabState,
} from './cleanup-closure-v2-validation';
import type { FrozenDocumentCommand } from './enforcement-persistence-v2';
import { validateDetachedFrozenDocumentCommand } from './enforcement-persistence-v2-validation';
import type { RuntimeTabState } from './runtime-leaf-types';
import type {
  CleanupEnforcementTarget,
  CleanupProgress,
  CleanupRetryState,
  CleanupSeed,
  CleanupTabClaim,
} from './runtime-v2-types';

export { CLEANUP_MAX_AUTOMATIC_ATTEMPTS };

/** Attempt 1 runs immediately. These delays schedule attempts 2 through 7. */
export const CLEANUP_RETRY_DELAYS_MS: readonly number[] = [
  60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000,
];

/** Attempts 8 through 12 are six hours apart. */
const CLEANUP_LONG_RETRY_DELAY_MS: number = 6 * 60 * 60_000;

/**
 * The one verdict a clear command may carry, re-exported under the name this module's callers use.
 * It is the validator's comparison authority itself, so no producer copy can drift from it. Every
 * command still gets its own copy of the value.
 */
export const NO_SESSION_VERDICT: Verdict = CANONICAL_CLEAR_VERDICT;

export interface ClearCommandIdentityV2 {
  operationId: string;
  enforcementEpoch: string;
  sessionId: string | null;
  reservedSessionId: string | null;
  basePolicyRevision: number;
  runtimeRevision: number;
}

export interface CleanupProgressInputV2 {
  cleanupOperationId: string;
  clearRuntimeRevision: number;
  targets: readonly CleanupEnforcementTarget[];
  identity: Omit<ClearCommandIdentityV2, 'operationId' | 'runtimeRevision'>;
  seed: CleanupSeed;
  at: number;
  batch: number;
}

export interface CleanupBatchReplacementV2 {
  cleanupOperationId: string;
  clearRuntimeRevision: number;
  at: number;
}

/** The map key for document authority, everywhere in the v2 runtime. */
export function documentCommandKeyV2(tabId: number, documentId: string): string {
  if (!isNonNegativeInteger(tabId)) {
    invalidCleanup(`cleanup command tab ${String(tabId)} is not a tab ID`);
  }
  if (!isNonBlankString(documentId)) invalidCleanup('cleanup command needs a document ID');
  return `${tabId}:${documentId}`;
}

/** Returns when the attempt after `automaticAttempt` runs, or null once the batch is exhausted. */
export function nextCleanupAttemptAtV2(automaticAttempt: number, at: number): number | null {
  if (!isNonNegativeInteger(automaticAttempt)) {
    invalidCleanup('cleanup attempt count must be a non-negative safe integer');
  }
  if (!isSafeTimestamp(at)) invalidCleanup('cleanup attempt time must be a safe timestamp');
  if (automaticAttempt >= CLEANUP_MAX_AUTOMATIC_ATTEMPTS) return null;
  if (automaticAttempt === 0) return at;
  const delay: number =
    CLEANUP_RETRY_DELAYS_MS[automaticAttempt - 1] ?? CLEANUP_LONG_RETRY_DELAY_MS;
  const next: number = at + delay;
  if (!isSafeTimestamp(next)) invalidCleanup('next cleanup attempt leaves the safe integer range');
  return next;
}

export function freshCleanupRetryStateV2(batch: number, at: number): CleanupRetryState {
  return validatedRetry({ batch, automaticAttempt: 0, nextAttemptAt: at, lastError: null });
}

export function recordCleanupAttemptFailureV2(
  retry: CleanupRetryState,
  at: number,
  error: string,
): CleanupRetryState {
  if (!isNonBlankString(error)) invalidCleanup('a cleanup failure needs a non-blank error');
  const automaticAttempt: number = retry.automaticAttempt + 1;
  if (automaticAttempt > CLEANUP_MAX_AUTOMATIC_ATTEMPTS) {
    invalidCleanup('cleanup batch is exhausted and needs a manual batch');
  }
  return validatedRetry({
    batch: retry.batch,
    automaticAttempt,
    nextAttemptAt: nextCleanupAttemptAtV2(automaticAttempt, at),
    lastError: error,
  });
}

export function beginManualCleanupBatchV2(retry: CleanupRetryState, at: number): CleanupRetryState {
  return validatedRetry({
    batch: retry.batch + 1,
    automaticAttempt: 0,
    nextAttemptAt: at,
    lastError: null,
  });
}

export function buildFrozenClearCommandV2(
  target: CleanupEnforcementTarget,
  identity: ClearCommandIdentityV2,
): FrozenDocumentCommand {
  if (canonicalSessionIdentity(identity.sessionId, identity.reservedSessionId) === null) {
    invalidCleanup('a clear command carries exactly one of sessionId and reservedSessionId');
  }
  const command: FrozenDocumentCommand = {
    version: 1,
    command: 'apply-enforcement',
    operationId: identity.operationId,
    enforcementEpoch: identity.enforcementEpoch,
    sessionId: identity.sessionId,
    reservedSessionId: identity.reservedSessionId,
    basePolicyRevision: identity.basePolicyRevision,
    runtimeRevision: identity.runtimeRevision,
    documentId: target.documentId,
    expectedUrl: target.expectedUrl,
    presentation: 'clear',
    verdict: { ...NO_SESSION_VERDICT },
    overlay: null,
    tabId: target.tabId,
  };
  if (!validateDetachedFrozenDocumentCommand(command)) {
    invalidCleanup('clear command does not satisfy the frozen command contract');
  }
  return command;
}

/** Captures alarm ownership and one claim per tab, sorted by tab ID and detached from the caller. */
export function buildCleanupSeedV2(
  alarmNames: readonly string[],
  tabStates: Record<number, RuntimeTabState>,
): CleanupSeed {
  const seed: CleanupSeed = {
    alarmNames: [...alarmNames],
    tabClaims: capturedTabClaims(tabStates),
  };
  if (!validateDetachedCleanupSeed(seed)) {
    invalidCleanup('cleanup seed does not satisfy the stored seed contract');
  }
  return seed;
}

export function buildCleanupProgressV2(input: CleanupProgressInputV2): CleanupProgress {
  const identity: ClearCommandIdentityV2 = {
    ...input.identity,
    operationId: input.cleanupOperationId,
    runtimeRevision: input.clearRuntimeRevision,
  };
  const targets: Record<string, CleanupEnforcementTarget> = {};
  const clearCommands: Record<string, FrozenDocumentCommand> = {};
  for (const target of input.targets) {
    addKeyedTarget(targets, clearCommands, target, identity);
  }
  return validatedProgress({
    cleanupOperationId: input.cleanupOperationId,
    clearRuntimeRevision: input.clearRuntimeRevision,
    targets,
    clearCommands,
    tabClaims: input.seed.tabClaims.map(capturedTabClaim),
    resolvedTabIds: [],
    retry: freshCleanupRetryStateV2(input.batch, input.at),
  });
}

/**
 * Merges one newly discovered claim into progress. Saved ownership wins, a saved null may be filled
 * once, and contradictory ownership is a cleanup error rather than an overwrite.
 */
export function mergeCleanupTabClaimV2(
  progress: CleanupProgress,
  claim: CleanupTabClaim,
): CleanupProgress {
  const observed: CleanupTabClaim = capturedTabClaim(claim);
  if (!validateDetachedCleanupTabClaim(observed)) {
    invalidCleanup('a cleanup tab claim needs a tab ID and a captured state');
  }
  const next: CleanupProgress = detachedCopy(progress);
  const saved: CleanupTabClaim | undefined = next.tabClaims.find(
    (candidate: CleanupTabClaim): boolean => candidate.tabId === observed.tabId,
  );
  if (saved === undefined) {
    next.tabClaims = [...next.tabClaims, observed].sort(byTabId);
  } else {
    saved.state = mergeTabState(saved.state, observed.state);
  }
  return validatedProgress(next);
}

/** Adds a newly discovered document under the batch's own operation ID and clear revision. */
export function addCleanupTargetV2(
  progress: CleanupProgress,
  target: CleanupEnforcementTarget,
  identity: Omit<ClearCommandIdentityV2, 'operationId' | 'runtimeRevision'>,
): CleanupProgress {
  const next: CleanupProgress = detachedCopy(progress);
  assertBatchIdentityAgrees(next, identity);
  addKeyedTarget(next.targets, next.clearCommands, target, {
    ...identity,
    operationId: next.cleanupOperationId,
    runtimeRevision: next.clearRuntimeRevision,
  });
  return validatedProgress(next);
}

/**
 * A discovered document joins the batch that froze the others, so it carries that batch's policy
 * identity. The stored-progress validator already refuses a divergent enforcement epoch; the base
 * policy revision is the half it does not see, and a command carrying a newer one is a command the
 * commit guard would refuse after the write.
 */
function assertBatchIdentityAgrees(
  progress: CleanupProgress,
  identity: Omit<ClearCommandIdentityV2, 'operationId' | 'runtimeRevision'>,
): void {
  const frozen: FrozenDocumentCommand | undefined = Object.values(progress.clearCommands)[0];
  if (frozen === undefined) return;
  if (frozen.basePolicyRevision !== identity.basePolicyRevision) {
    invalidCleanup('a discovered cleanup target carries the batch base policy revision');
  }
}

export function resolveCleanupTabV2(progress: CleanupProgress, tabId: number): CleanupProgress {
  if (!isNonNegativeInteger(tabId)) {
    invalidCleanup(`cleanup resolved tab ${String(tabId)} is not a tab ID`);
  }
  const next: CleanupProgress = detachedCopy(progress);
  if (!next.resolvedTabIds.includes(tabId)) {
    next.resolvedTabIds = [...next.resolvedTabIds, tabId].sort(ascending);
  }
  return validatedProgress(next);
}

/**
 * Manual retry: a new operation ID and clear revision replace the batch identity in progress and in
 * every frozen command. Targets, claims, and resolved tab IDs are the facts this batch inherits.
 */
export function replaceCleanupBatchV2(
  progress: CleanupProgress,
  input: CleanupBatchReplacementV2,
): CleanupProgress {
  // The commit guard refuses a replacement that keeps the clear revision or the operation ID, so
  // the builder refuses to emit one rather than leaving the caller to discover it at the commit.
  if (input.clearRuntimeRevision <= progress.clearRuntimeRevision) {
    invalidCleanup('a replacement cleanup batch advances the clear revision');
  }
  if (input.cleanupOperationId === progress.cleanupOperationId) {
    invalidCleanup('a replacement cleanup batch allocates a new operation ID');
  }
  const next: CleanupProgress = detachedCopy(progress);
  next.cleanupOperationId = input.cleanupOperationId;
  next.clearRuntimeRevision = input.clearRuntimeRevision;
  next.clearCommands = Object.fromEntries(
    Object.entries(next.clearCommands).map(
      ([key, command]: [string, FrozenDocumentCommand]): [string, FrozenDocumentCommand] => [
        key,
        {
          ...command,
          operationId: input.cleanupOperationId,
          runtimeRevision: input.clearRuntimeRevision,
        },
      ],
    ),
  );
  next.retry = beginManualCleanupBatchV2(progress.retry, input.at);
  return validatedProgress(next);
}

function addKeyedTarget(
  targets: Record<string, CleanupEnforcementTarget>,
  clearCommands: Record<string, FrozenDocumentCommand>,
  target: CleanupEnforcementTarget,
  identity: ClearCommandIdentityV2,
): void {
  const key: string = documentCommandKeyV2(target.tabId, target.documentId);
  if (Object.hasOwn(targets, key)) return;
  targets[key] = {
    tabId: target.tabId,
    documentId: target.documentId,
    expectedUrl: target.expectedUrl,
  };
  clearCommands[key] = buildFrozenClearCommandV2(target, identity);
}

function capturedTabClaims(tabStates: Record<number, RuntimeTabState>): CleanupTabClaim[] {
  const claims: CleanupTabClaim[] = [];
  for (const [key, state] of Object.entries(tabStates)) {
    const tabId: number = Number(key);
    if (!isNonNegativeInteger(tabId) || String(tabId) !== key) {
      invalidCleanup(`cleanup claim key ${JSON.stringify(key)} is not a tab ID`);
    }
    claims.push({ tabId, state: capturedTabState(state) });
  }
  return claims.sort(byTabId);
}

function capturedTabClaim(claim: CleanupTabClaim): CleanupTabClaim {
  return { tabId: claim.tabId, state: capturedTabState(claim.state) };
}

function capturedTabState(value: unknown): RuntimeTabState {
  const snapshot: ExactDataSnapshot | null = snapshotExactData(value);
  if (snapshot === null || !validateDetachedRuntimeTabState(snapshot.value)) {
    invalidCleanup('a cleanup claim needs an exact captured tab state');
  }
  return snapshot.value;
}

function mergeTabState(saved: RuntimeTabState, observed: RuntimeTabState): RuntimeTabState {
  return {
    muteUrl: mergedOwnership(saved.muteUrl, observed.muteUrl, 'mute URL'),
    priorMuted: mergedOwnership(saved.priorMuted, observed.priorMuted, 'prior mute state'),
    stoppedDocumentId: mergedOwnership(
      saved.stoppedDocumentId,
      observed.stoppedDocumentId,
      'stopped document',
    ),
  };
}

function mergedOwnership<T>(saved: T | null, observed: T | null, label: string): T | null {
  if (saved === null || observed === null) return saved ?? observed;
  if (saved !== observed) invalidCleanup(`a newly observed ${label} contradicts the saved claim`);
  return saved;
}

function validatedRetry(retry: CleanupRetryState): CleanupRetryState {
  if (!validateDetachedCleanupRetryState(retry)) {
    invalidCleanup('cleanup retry state does not satisfy the stored retry contract');
  }
  return retry;
}

function validatedProgress(progress: CleanupProgress): CleanupProgress {
  if (!validateDetachedCleanupProgress(progress)) {
    invalidCleanup('cleanup progress does not satisfy the stored cleanup contract');
  }
  return progress;
}

function detachedCopy<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return invalidCleanup('cleanup progress is not cloneable exact data');
  }
}

function byTabId(left: CleanupTabClaim, right: CleanupTabClaim): number {
  return left.tabId - right.tabId;
}

function ascending(left: number, right: number): number {
  return left - right;
}

function invalidCleanup(message: string): never {
  throw new CoreError('invalid-rule', message);
}
