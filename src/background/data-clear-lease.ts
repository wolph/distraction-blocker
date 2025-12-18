/**
 * The exclusive all-data deletion lease and the one token-checked journal transaction.
 *
 * Main creates a single lease before Policy Storage, Engine, install-profile classification, and
 * `runtime.onInstalled` work start, then injects it into every owner of an all-data clear phase.
 * The lease is a FIFO serializer, not an Engine-owned lock: it is always the outermost lock, so a
 * caller acquires it before any Engine runtime-mutation lease and an Engine callback receives the
 * existing token rather than reacquiring it.
 *
 * `transactDataClearJournal` is the only path that writes `dataClearJournal`. It holds the current
 * token from a fresh read through the exact read-back, so a caller cannot cache a journal, release
 * the lease, and write that whole value later. Each transform sees the current stored value and
 * returns the value it owns, which is what keeps a remote inventory write and a lifecycle-intent
 * append from overwriting each other in either order.
 */

import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../shared/storage-keys';
import {
  type DataClearJournal,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  parseDataClearJournal,
} from './data-clear-journal';

type StoredJournal = DataClearJournal | LegacyAllDataClearJournal;

/** The proof that its holder is the operation the lease is currently running. */
export interface DataClearLeaseToken {
  readonly id: number;
}

export interface AllDataClearLease {
  /** Runs one operation exclusively. Queued callers run in acquisition order. */
  run<T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T>;
  /** True only for the token of the operation running right now. */
  isCurrent(token: DataClearLeaseToken): boolean;
  /** True from the acquisition call until the last queued operation settles. */
  held(): boolean;
}

/**
 * Receives the current stored journal, or null when none is stored, and returns the next journal,
 * null to remove it, or `'unchanged'` to write nothing.
 */
export type JournalTransform = (
  current: StoredJournal | null,
) => DataClearJournal | null | 'unchanged';

interface LeaseState {
  /** The FIFO chain. It never rejects, so a failed operation cannot strand its successors. */
  tail: Promise<void>;
  current: DataClearLeaseToken | null;
  pending: number;
  insideOperation: boolean;
  nextId: number;
}

export function createAllDataClearLease(): AllDataClearLease {
  const state: LeaseState = {
    tail: Promise.resolve(),
    current: null,
    pending: 0,
    insideOperation: false,
    nextId: 1,
  };
  return {
    run: <T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T> =>
      runExclusive(state, operation),
    isCurrent: (token: DataClearLeaseToken): boolean => state.current === token,
    held: (): boolean => state.pending > 0,
  };
}

/**
 * One read-modify-write of the all-data journal under the current token. It rereads storage, hands
 * the fresh value to the transform, writes at most once, and verifies the exact read-back.
 */
export async function transactDataClearJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
  transform: JournalTransform,
): Promise<DataClearJournal | null> {
  if (!lease.isCurrent(token)) {
    throw new CoreError(
      'lease-order',
      'an all-data journal transaction needs the current deletion-lease token',
    );
  }
  const current: StoredJournal | null = await readStoredJournal();
  const next: DataClearJournal | null | 'unchanged' = transform(current);
  if (next === 'unchanged') return unchangedJournal(current);
  if (next === null) {
    await removeStoredJournal();
    return null;
  }
  const written: DataClearJournal = validatedTransformResult(next);
  await writeStoredJournal(written);
  return written;
}

/**
 * The fixed lock order. The shared deletion lease is outermost, so a caller already holding an
 * Engine runtime lease must pass its deletion token down instead of acquiring a second lease.
 */
export function assertNoEngineRuntimeLease(engineLeaseHeld: () => boolean): void {
  if (engineLeaseHeld()) {
    throw new CoreError(
      'lease-order',
      'the shared deletion lease is outermost and cannot be acquired under an engine runtime lease',
    );
  }
}

function runExclusive<T>(
  state: LeaseState,
  operation: (token: DataClearLeaseToken) => Promise<T>,
): Promise<T> {
  if (state.insideOperation) {
    throw new CoreError(
      'lease-order',
      'the shared deletion lease cannot be reacquired inside an owner callback',
    );
  }
  const token: DataClearLeaseToken = { id: state.nextId };
  state.nextId += 1;
  state.pending += 1;
  const started: Promise<T> = state.tail.then((): Promise<T> => holdLease(state, token, operation));
  state.tail = started.then(
    (): void => undefined,
    (): void => undefined,
  );
  return started;
}

async function holdLease<T>(
  state: LeaseState,
  token: DataClearLeaseToken,
  operation: (token: DataClearLeaseToken) => Promise<T>,
): Promise<T> {
  state.current = token;
  try {
    return await callOperation(state, token, operation);
  } finally {
    state.current = null;
    state.pending -= 1;
  }
}

/**
 * The reentrancy flag covers the operation's own synchronous frame, which is where a nested
 * acquisition is distinguishable from a second acquirer that legitimately queues behind this one.
 * A nested call made after the operation awaits is indistinguishable from an external arrival and
 * still queues, so owners pass their token down rather than reacquiring at any point.
 */
function callOperation<T>(
  state: LeaseState,
  token: DataClearLeaseToken,
  operation: (token: DataClearLeaseToken) => Promise<T>,
): Promise<T> {
  state.insideOperation = true;
  try {
    return operation(token);
  } finally {
    state.insideOperation = false;
  }
}

async function readStoredJournal(): Promise<StoredJournal | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DATA_CLEAR_JOURNAL);
  const raw: unknown = stored[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw === undefined) return null;
  const parsed: StoredJournal | null = parseDataClearJournal(raw);
  if (parsed === null) {
    // The throw is the report: the caller owns what to do with a stored value no owner can
    // transform, and no transform may decide against a value this module could not parse.
    throw storedJournalError('the stored data clear journal failed parsing', raw);
  }
  return parsed;
}

/**
 * A legacy all-data value is migration input, and every lease holder that reads one upgrades it
 * before releasing, so leaving it in place is a caller defect rather than a quiet no-op.
 */
function unchangedJournal(current: StoredJournal | null): DataClearJournal | null {
  if (current !== null && isLegacyAllDataClearJournal(current)) {
    throw new CoreError(
      'invalid-rule',
      'a legacy all-data journal upgrades under the lease and is never left unchanged',
    );
  }
  return current;
}

/** Validation happens before the write, and the detached parse result is what reaches storage. */
function validatedTransformResult(next: DataClearJournal): DataClearJournal {
  const parsed: StoredJournal | null = parseDataClearJournal(next);
  if (parsed === null || isLegacyAllDataClearJournal(parsed)) {
    throw new CoreError(
      'invalid-rule',
      'a journal transform must return a current journal shape, never an invalid or legacy value',
    );
  }
  return parsed;
}

async function writeStoredJournal(journal: DataClearJournal): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_DATA_CLEAR_JOURNAL]: journal });
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DATA_CLEAR_JOURNAL);
  const raw: unknown = stored[LOCAL_DATA_CLEAR_JOURNAL];
  if (!exactDataEqual(raw, journal)) {
    throw storedJournalError(
      'the data clear journal read back differently than it was written',
      raw,
    );
  }
}

async function removeStoredJournal(): Promise<void> {
  await chrome.storage.local.remove(LOCAL_DATA_CLEAR_JOURNAL);
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DATA_CLEAR_JOURNAL);
  const raw: unknown = stored[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw !== undefined) {
    throw storedJournalError('the data clear journal is still stored after its removal', raw);
  }
}

/** The raw stored value rides along as `cause` so the reporting caller can log what it found. */
function storedJournalError(message: string, raw: unknown): CoreError {
  const error: CoreError = new CoreError('storage', message);
  error.cause = raw;
  return error;
}
