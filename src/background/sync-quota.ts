import { LOCAL_SYNC_QUOTA_EVICTION } from '../shared/storage-keys';
import { assertSyncItemWithinQuota, serializeSyncValue, syncItemBytes } from './sync-item-size';
import { isAuthoritativeSyncItem, isSupportedSyncItemKey } from './sync-item-validation';
import { SyncQuotaError } from './sync-quota-shared';

export { assertSyncItemWithinQuota, syncItemBytes } from './sync-item-size';
export { SYNC_QUOTA_BYTES_PER_ITEM, SyncQuotaError } from './sync-quota-shared';
export const SYNC_QUOTA_BYTES_TOTAL: number = 102_400;

const MONTHLY_AGG_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;

let syncMutationQueue: Promise<void> = Promise.resolve();

interface MonthlyQuotaCandidate {
  bytes: number;
  key: string;
  month: string;
}

interface SyncQuotaEvictionCheckpoint {
  evicted: Record<string, unknown>;
  setKeys: string[];
}

function isDensePlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every((key: string | symbol): boolean => {
    if (typeof key !== 'string') return false;
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && Object.hasOwn(descriptor, 'value');
  });
}

function invalidEvictionCheckpoint(): never {
  throw new SyncQuotaError('Cannot replay invalid sync quota eviction checkpoint.');
}

function validateCheckpointItem(key: string, value: unknown): void {
  try {
    assertSyncItemWithinQuota(key, value);
  } catch (_error: unknown) {
    invalidEvictionCheckpoint();
  }
}

function validateEvictedEntries(evicted: Record<string, unknown>): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = Object.entries(evicted);
  if (entries.length === 0) invalidEvictionCheckpoint();
  for (const [key, value] of entries) {
    if (!MONTHLY_AGG_KEY_RE.test(key) || !isAuthoritativeSyncItem(key, value)) {
      invalidEvictionCheckpoint();
    }
    validateCheckpointItem(key, value);
  }
  return entries;
}

function validateSetKeys(value: unknown, evicted: Record<string, unknown>): string[] {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) {
    invalidEvictionCheckpoint();
  }
  const setKeys: string[] = [];
  const seen: Set<string> = new Set();
  for (const key of value) {
    if (
      typeof key !== 'string' ||
      seen.has(key) ||
      Object.hasOwn(evicted, key) ||
      !isSupportedSyncItemKey(key)
    ) {
      invalidEvictionCheckpoint();
    }
    seen.add(key);
    setKeys.push(key);
  }
  return setKeys;
}

function parseEvictionCheckpoint(value: unknown): SyncQuotaEvictionCheckpoint {
  if (!isDensePlainRecord(value)) invalidEvictionCheckpoint();
  const checkpointKeys: string[] = Object.keys(value).sort();
  const evicted: unknown = value.evicted;
  if (!isDensePlainRecord(evicted)) invalidEvictionCheckpoint();
  validateEvictedEntries(evicted);
  if (
    checkpointKeys.length === 2 &&
    checkpointKeys[0] === 'evicted' &&
    checkpointKeys[1] === 'setKeys'
  ) {
    return { evicted, setKeys: validateSetKeys(value.setKeys, evicted) };
  }
  if (
    checkpointKeys.length !== 2 ||
    checkpointKeys[0] !== 'evicted' ||
    checkpointKeys[1] !== 'retained' ||
    !isDensePlainRecord(value.retained)
  ) {
    invalidEvictionCheckpoint();
  }
  const retainedEntries: Array<[string, unknown]> = Object.entries(value.retained);
  let retainedBytes: number = 0;
  for (const [key, retainedValue] of retainedEntries) {
    if (Object.hasOwn(evicted, key) || !isAuthoritativeSyncItem(key, retainedValue)) {
      invalidEvictionCheckpoint();
    }
    validateCheckpointItem(key, retainedValue);
    retainedBytes += syncItemBytes(key, retainedValue);
  }
  if (retainedBytes > SYNC_QUOTA_BYTES_TOTAL) invalidEvictionCheckpoint();
  return { evicted, setKeys: retainedEntries.map(([key]: [string, unknown]): string => key) };
}

async function loadEvictionCheckpoint(
  checkpointStorage: chrome.storage.StorageArea,
): Promise<SyncQuotaEvictionCheckpoint | null> {
  const loaded: Record<string, unknown> = await checkpointStorage.get(LOCAL_SYNC_QUOTA_EVICTION);
  if (!Object.hasOwn(loaded, LOCAL_SYNC_QUOTA_EVICTION)) return null;
  return parseEvictionCheckpoint(loaded[LOCAL_SYNC_QUOTA_EVICTION]);
}

function syncValuesEqual(left: unknown, right: unknown): boolean {
  try {
    return serializeSyncValue('checkpoint', left) === serializeSyncValue('checkpoint', right);
  } catch (_error: unknown) {
    return false;
  }
}

async function supersedeCheckpointKeys(
  checkpoint: SyncQuotaEvictionCheckpoint,
  keys: readonly string[],
  checkpointStorage: chrome.storage.StorageArea,
): Promise<SyncQuotaEvictionCheckpoint | null> {
  if (keys.length === 0) return checkpoint;
  const superseded: Set<string> = new Set(keys);
  const evicted: Record<string, unknown> = Object.fromEntries(
    Object.entries(checkpoint.evicted).filter(
      ([key]: [string, unknown]): boolean => !superseded.has(key),
    ),
  );
  if (Object.keys(evicted).length === 0) {
    await checkpointStorage.remove(LOCAL_SYNC_QUOTA_EVICTION);
    return null;
  }
  const updated: SyncQuotaEvictionCheckpoint = {
    evicted,
    setKeys: checkpoint.setKeys.filter((key: string): boolean => !superseded.has(key)),
  };
  await checkpointStorage.set({ [LOCAL_SYNC_QUOTA_EVICTION]: updated });
  return updated;
}

async function recoverEvictionCheckpoint(
  storage: chrome.storage.SyncStorageArea,
  checkpointStorage: chrome.storage.StorageArea,
  intended: Record<string, unknown> | null = null,
  supersedingRemovals: readonly string[] = [],
): Promise<boolean> {
  let checkpoint: SyncQuotaEvictionCheckpoint | null =
    await loadEvictionCheckpoint(checkpointStorage);
  if (checkpoint === null) return false;
  checkpoint = await supersedeCheckpointKeys(checkpoint, supersedingRemovals, checkpointStorage);
  if (checkpoint === null) return false;
  const loaded: [Record<string, unknown>, number] = await Promise.all([
    storage.get(null) as Promise<Record<string, unknown>>,
    storage.getBytesInUse(null),
  ]);
  const stored: Record<string, unknown> = loaded[0];
  if (
    intended !== null &&
    checkpoint.setKeys.length > 0 &&
    checkpoint.setKeys.every(
      (key: string): boolean =>
        Object.hasOwn(intended, key) &&
        Object.hasOwn(stored, key) &&
        syncValuesEqual(intended[key], stored[key]),
    )
  ) {
    await checkpointStorage.remove(LOCAL_SYNC_QUOTA_EVICTION);
    return false;
  }
  const restoreEntries: Array<[string, unknown]> = Object.entries(checkpoint.evicted).filter(
    ([key]: [string, unknown]): boolean =>
      !Object.hasOwn(stored, key) || !isAuthoritativeSyncItem(key, stored[key]),
  );
  if (restoreEntries.length === 0) {
    await checkpointStorage.remove(LOCAL_SYNC_QUOTA_EVICTION);
    return false;
  }
  const projectedBytes: number =
    loaded[1] - replacementBytes(stored, restoreEntries) + incomingBytes(restoreEntries);
  if (projectedBytes > SYNC_QUOTA_BYTES_TOTAL) return true;
  await storage.set(Object.fromEntries(restoreEntries));
  await checkpointStorage.remove(LOCAL_SYNC_QUOTA_EVICTION);
  return false;
}

function queueSyncMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const requested: Promise<T> = syncMutationQueue.then(mutation);
  syncMutationQueue = requested.then(
    (): void => undefined,
    (): void => undefined,
  );
  return requested;
}

function monthlyQuotaCandidates(projected: Record<string, unknown>): MonthlyQuotaCandidate[] {
  const candidates: MonthlyQuotaCandidate[] = [];
  const entries: Array<[string, unknown]> = Object.entries(projected);
  for (let index: number = 0; index < entries.length; index++) {
    const entry: [string, unknown] = entries[index] as [string, unknown];
    const key: string = entry[0];
    const month: string | undefined = MONTHLY_AGG_KEY_RE.exec(key)?.[1];
    if (month === undefined) continue;
    candidates.push({ bytes: syncItemBytes(key, entry[1]), key, month });
  }
  return candidates.sort(
    (left: MonthlyQuotaCandidate, right: MonthlyQuotaCandidate): number =>
      left.month.localeCompare(right.month) || left.key.localeCompare(right.key),
  );
}

function replacementBytes(
  stored: Record<string, unknown>,
  incomingEntries: Array<[string, unknown]>,
): number {
  return incomingEntries.reduce(
    (total: number, [key]: [string, unknown]): number =>
      total + (Object.hasOwn(stored, key) ? syncItemBytes(key, stored[key]) : 0),
    0,
  );
}

function incomingBytes(incomingEntries: Array<[string, unknown]>): number {
  return incomingEntries.reduce(
    (total: number, [key, value]: [string, unknown]): number => total + syncItemBytes(key, value),
    0,
  );
}

async function performQuotaCheckedSet(
  items: Record<string, unknown>,
  storage: chrome.storage.SyncStorageArea,
  checkpointStorage: chrome.storage.StorageArea | undefined,
): Promise<void> {
  const incomingEntries: Array<[string, unknown]> = Object.entries(items);
  if (incomingEntries.length === 0) return;
  for (let index: number = 0; index < incomingEntries.length; index++) {
    const entry: [string, unknown] = incomingEntries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    assertSyncItemWithinQuota(key, value);
  }

  if (checkpointStorage !== undefined) {
    const deferred: boolean = await recoverEvictionCheckpoint(storage, checkpointStorage, items);
    if (deferred) {
      throw new SyncQuotaError('Cannot sync batch until quota eviction rollback can be restored.');
    }
  }

  const loaded: [Record<string, unknown>, number] = await Promise.all([
    storage.get(null) as Promise<Record<string, unknown>>,
    storage.getBytesInUse(null),
  ]);
  const stored: Record<string, unknown> = loaded[0];
  const currentBytes: number = loaded[1];
  const projectedBytes: number =
    currentBytes - replacementBytes(stored, incomingEntries) + incomingBytes(incomingEntries);
  if (projectedBytes <= SYNC_QUOTA_BYTES_TOTAL) {
    await storage.set(items);
    return;
  }

  const projected: Record<string, unknown> = { ...stored, ...items };
  const candidates: MonthlyQuotaCandidate[] = monthlyQuotaCandidates(projected);
  const evictions: string[] = [];
  const compactedKeys: Set<string> = new Set();
  let compactedBytes: number = projectedBytes;
  for (let index: number = 0; index < candidates.length; index++) {
    const candidate: MonthlyQuotaCandidate = candidates[index] as MonthlyQuotaCandidate;
    if (compactedBytes <= SYNC_QUOTA_BYTES_TOTAL) break;
    compactedKeys.add(candidate.key);
    if (Object.hasOwn(stored, candidate.key)) evictions.push(candidate.key);
    compactedBytes -= candidate.bytes;
  }
  if (compactedBytes > SYNC_QUOTA_BYTES_TOTAL) {
    throw new SyncQuotaError(
      `Cannot sync batch: ${projectedBytes} bytes exceeds the ${SYNC_QUOTA_BYTES_TOTAL}-byte limit and cannot fit after compacting all monthly history.`,
    );
  }
  const retainedEntries: Array<[string, unknown]> = incomingEntries.filter(
    ([key]: [string, unknown]): boolean => !compactedKeys.has(key),
  );
  if (evictions.length > 0) {
    if (checkpointStorage === undefined) {
      throw new SyncQuotaError('Cannot compact Sync without durable checkpoint storage.');
    }
    const evicted: Record<string, unknown> = Object.fromEntries(
      evictions.map((key: string): [string, unknown] => [key, stored[key]]),
    );
    validateEvictedEntries(evicted);
    const checkpoint: SyncQuotaEvictionCheckpoint = {
      evicted,
      setKeys: validateSetKeys(
        retainedEntries.map(([key]: [string, unknown]): string => key),
        evicted,
      ),
    };
    await checkpointStorage.set({ [LOCAL_SYNC_QUOTA_EVICTION]: checkpoint });
    await storage.remove(evictions);
  }
  if (retainedEntries.length > 0) await storage.set(Object.fromEntries(retainedEntries));
  if (evictions.length > 0 && checkpointStorage !== undefined) {
    await checkpointStorage.remove(LOCAL_SYNC_QUOTA_EVICTION);
  }
}

/**
 * Writes one Sync batch after checking Chrome's authoritative current
 * byte usage. Oldest monthly aggregates are evicted only when needed.
 */
export function setSyncItemsWithinQuota(
  items: Record<string, unknown>,
  storage?: chrome.storage.SyncStorageArea,
  checkpointStorage?: chrome.storage.StorageArea,
): Promise<void> {
  const resolvedStorage: chrome.storage.SyncStorageArea = storage ?? chrome.storage.sync;
  const resolvedCheckpointStorage: chrome.storage.StorageArea | undefined =
    checkpointStorage ?? (storage === undefined ? chrome.storage.local : undefined);
  return queueSyncMutation(
    (): Promise<void> => performQuotaCheckedSet(items, resolvedStorage, resolvedCheckpointStorage),
  );
}

/** Restores a durable compaction rollback without trusting its prior set payload. */
export function replaySyncQuotaEvictionCheckpoint(
  storage?: chrome.storage.SyncStorageArea,
  checkpointStorage?: chrome.storage.StorageArea,
  supersedingRemovals: readonly string[] = [],
): Promise<void> {
  const resolvedStorage: chrome.storage.SyncStorageArea = storage ?? chrome.storage.sync;
  const resolvedCheckpointStorage: chrome.storage.StorageArea | undefined =
    checkpointStorage ?? (storage === undefined ? chrome.storage.local : undefined);
  if (resolvedCheckpointStorage === undefined) return Promise.resolve();
  return queueSyncMutation(async (): Promise<void> => {
    await recoverEvictionCheckpoint(
      resolvedStorage,
      resolvedCheckpointStorage,
      null,
      supersedingRemovals,
    );
  });
}

/** Serializes removals with quota preflight and writes. */
export function removeSyncItems(
  keys: string[],
  storage?: chrome.storage.SyncStorageArea,
  checkpointStorage?: chrome.storage.StorageArea,
): Promise<void> {
  const resolvedStorage: chrome.storage.SyncStorageArea = storage ?? chrome.storage.sync;
  const resolvedCheckpointStorage: chrome.storage.StorageArea | undefined =
    checkpointStorage ?? (storage === undefined ? chrome.storage.local : undefined);
  return queueSyncMutation(async (): Promise<void> => {
    if (keys.length === 0) return;
    if (resolvedCheckpointStorage !== undefined) {
      const checkpoint: SyncQuotaEvictionCheckpoint | null =
        await loadEvictionCheckpoint(resolvedCheckpointStorage);
      if (checkpoint !== null) {
        await supersedeCheckpointKeys(checkpoint, keys, resolvedCheckpointStorage);
      }
    }
    await resolvedStorage.remove(keys);
  });
}

export interface SyncJournalInput {
  sets: Readonly<Record<string, unknown>>;
  removes: readonly string[];
}

export interface SyncJournalRejection {
  key: string;
  message: string;
}

export interface SanitizedSyncJournal {
  journal: {
    sets: Record<string, unknown>;
    removes: string[];
  };
  rejected: SyncJournalRejection[];
}

export function sanitizeSyncJournal(journal: SyncJournalInput): SanitizedSyncJournal {
  const accepted: Array<[string, unknown]> = [];
  const rejected: SyncJournalRejection[] = [];
  for (const [key, value] of Object.entries(journal.sets)) {
    try {
      assertSyncItemWithinQuota(key, value);
      accepted.push([key, value]);
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : `Cannot sync item ${JSON.stringify(key)}.`;
      rejected.push({ key, message });
    }
  }
  return {
    journal: {
      sets: Object.fromEntries(accepted),
      removes: [...journal.removes],
    },
    rejected,
  };
}
