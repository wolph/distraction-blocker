/**
 * The exclusive all-data deletion lease and the one token-checked journal transaction.
 *
 * Main creates a single lease before Policy Storage, Engine, install-profile classification, and
 * `runtime.onInstalled` work start, then injects it into every owner of an all-data clear phase.
 * The lease is a FIFO serializer, not an Engine-owned lock: it is always the outermost lock, so
 * acquisition refuses to proceed while the Engine runtime lease its creator names is held, and an
 * Engine callback receives the existing token rather than reacquiring it.
 *
 * `transactDataClearJournal` holds the current token from a fresh read through the exact read-back.
 * One transaction runs at a time under a token, and the token is rechecked immediately before the
 * write, so neither a second transaction under one holder nor a transaction that outlives its
 * operation can overwrite a whole journal. It will be the only path that writes `dataClearJournal`
 * once Policy Storage moves onto it in Task 3. Each transform sees the current stored value and
 * returns the value it owns, which is what keeps a remote inventory write and a lifecycle-intent
 * append from overwriting each other in either order.
 *
 * Reentrancy is refused only while the operation's own synchronous frame runs, which is the only
 * window where a nested acquisition is distinguishable from a second acquirer that legitimately
 * queues behind this one. A `run` call made after the operation awaits still queues, behind the
 * operation that is waiting for it, and deadlocks. Owners pass their token down. They never
 * reacquire.
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
  /**
   * Runs one operation exclusively. Queued callers run in acquisition order. Acquiring while the
   * Engine runtime lease is held, or from an operation's own synchronous frame, throws
   * `CoreError('lease-order', ...)`. An owner that reacquires after awaiting is not detectable and
   * deadlocks, so owners pass their token down instead of reacquiring at any point.
   */
  run<T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T>;
  /** True only for the token of the operation running right now. */
  isCurrent(token: DataClearLeaseToken): boolean;
  /** True from the acquisition call until the last queued operation settles. */
  held(): boolean;
  /**
   * Claims the single journal-transaction slot for the current token and returns its release. It
   * throws `CoreError('lease-order', ...)` for a token that is not current and for a second
   * transaction while one is in flight. `transactDataClearJournal` is its only caller.
   */
  claimJournalTransaction(token: DataClearLeaseToken): () => void;
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
  /** The token whose transaction is in flight, so a stale claim cannot block a later one. */
  transactingToken: DataClearLeaseToken | null;
  nextId: number;
  engineLeaseHeld: () => boolean;
}

/**
 * `engineLeaseHeld` reports whether the caller holds an Engine runtime lease right now. Main builds
 * the lease before Engine exists, so it passes a closure that reads its Engine slot and answers
 * false until Engine is constructed.
 */
export function createAllDataClearLease(engineLeaseHeld: () => boolean): AllDataClearLease {
  const state: LeaseState = {
    tail: Promise.resolve(),
    current: null,
    pending: 0,
    insideOperation: false,
    transactingToken: null,
    nextId: 1,
    engineLeaseHeld,
  };
  return {
    run: <T>(operation: (token: DataClearLeaseToken) => Promise<T>): Promise<T> =>
      runExclusive(state, operation),
    isCurrent: (token: DataClearLeaseToken): boolean => state.current === token,
    held: (): boolean => state.pending > 0,
    claimJournalTransaction: (token: DataClearLeaseToken): (() => void) =>
      claimJournalTransaction(state, token),
  };
}

/**
 * One read-modify-write of the all-data journal under the current token. It claims the lease's
 * single transaction slot, rereads storage, hands the fresh value to the transform, rechecks the
 * token, writes at most once, and verifies the exact read-back.
 */
export async function transactDataClearJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
  transform: JournalTransform,
): Promise<DataClearJournal | null> {
  const release: () => void = lease.claimJournalTransaction(token);
  try {
    const current: StoredJournal | null = await readStoredJournal();
    const next: DataClearJournal | null | 'unchanged' = transform(current);
    if (next === 'unchanged') return unchangedJournal(current);
    if (next === null) {
      await removeStoredJournal(lease, token);
      return null;
    }
    const written: DataClearJournal = validatedTransformResult(next);
    await writeStoredJournal(lease, token, written);
    return written;
  } finally {
    release();
  }
}

/**
 * The fixed lock order. The shared deletion lease is outermost, so a caller already holding an
 * Engine runtime lease must pass its deletion token down instead of acquiring a second lease.
 * `run` consults its own predicate through this function, and a caller that acquires outside the
 * lease's knowledge may call it directly.
 */
export function assertNoEngineRuntimeLease(engineLeaseHeld: () => boolean): void {
  if (engineRuntimeLeaseHeld(engineLeaseHeld)) {
    throw new CoreError(
      'lease-order',
      'the shared deletion lease is outermost and cannot be acquired under an engine runtime lease',
    );
  }
}

/**
 * Main binds this predicate before Engine exists, so it reads a slot that is still empty, still in
 * its temporal dead zone, or guarded by a getter of its own. A throw from it is a lock-order
 * failure at the acquisition point, not an unrelated crash, so it is reported as one.
 */
function engineRuntimeLeaseHeld(engineLeaseHeld: () => boolean): boolean {
  try {
    return engineLeaseHeld();
  } catch (error: unknown) {
    const failure: CoreError = new CoreError(
      'lease-order',
      'the engine runtime-lease predicate could not be read, so acquisition is refused',
    );
    failure.cause = error;
    throw failure;
  }
}

function runExclusive<T>(
  state: LeaseState,
  operation: (token: DataClearLeaseToken) => Promise<T>,
): Promise<T> {
  assertNoEngineRuntimeLease(state.engineLeaseHeld);
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
    state.transactingToken = null;
    state.pending -= 1;
  }
}

/** The reentrancy flag covers the operation's own synchronous frame. See the module header. */
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

/**
 * Two concurrent transactions under one token would each read the same value and the later write
 * would drop the earlier change, so the second is refused: a holder that needs two changes at once
 * makes them in one transform. Sequential transactions under one token are the normal case, and
 * finalization replay depends on them: it advances the marker projection, materializes the marker,
 * and removes the applied intent, which is two transactions with a write between them.
 *
 * The claim is keyed on the token, so a transaction abandoned by a released operation cannot refuse
 * the next operation's first transaction with a concurrency message it did not earn.
 */
function claimJournalTransaction(state: LeaseState, token: DataClearLeaseToken): () => void {
  if (state.current !== token) {
    throw new CoreError(
      'lease-order',
      'an all-data journal transaction needs the current deletion-lease token',
    );
  }
  if (state.transactingToken === token) {
    throw new CoreError(
      'lease-order',
      'one all-data journal transaction runs at a time under the deletion lease',
    );
  }
  state.transactingToken = token;
  let released: boolean = false;
  return (): void => {
    if (released) return;
    released = true;
    if (state.transactingToken === token) state.transactingToken = null;
  };
}

/**
 * The write half of the invariant. A transaction that outlived its operation, because the owner
 * never awaited it, would otherwise land on the next holder's fresh read.
 */
function assertStillCurrent(lease: AllDataClearLease, token: DataClearLeaseToken): void {
  if (!lease.isCurrent(token)) {
    throw new CoreError(
      'lease-order',
      'the deletion lease was released before the journal write, so the write is refused',
    );
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

async function writeStoredJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
  journal: DataClearJournal,
): Promise<void> {
  assertStillCurrent(lease, token);
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

async function removeStoredJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
): Promise<void> {
  assertStillCurrent(lease, token);
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
