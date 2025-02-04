export const SYNC_QUOTA_BYTES_PER_ITEM: number = 8_192;
export const SYNC_QUOTA_BYTES_TOTAL: number = 102_400;

const MONTHLY_AGG_KEY_RE: RegExp = /^aggm:[^:]+:(\d{4}-\d{2})$/;

let syncMutationQueue: Promise<void> = Promise.resolve();

export class SyncQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncQuotaError';
  }
}

function serializeSyncValue(key: string, value: unknown): string {
  try {
    const serialized: string | undefined = JSON.stringify(value);
    if (serialized !== undefined) return serialized;
  } catch (_error: unknown) {
    // Normalize JSON.stringify failures into one stable boundary error.
  }
  throw new SyncQuotaError(
    `Cannot sync item ${JSON.stringify(key)}: value cannot be serialized as JSON.`,
  );
}

export function syncItemBytes(key: string, value: unknown): number {
  const serialized: string = serializeSyncValue(key, value);
  const encoder: TextEncoder = new TextEncoder();
  return encoder.encode(key).byteLength + encoder.encode(serialized).byteLength;
}

export function assertSyncItemWithinQuota(key: string, value: unknown): void {
  const bytes: number = syncItemBytes(key, value);
  if (bytes <= SYNC_QUOTA_BYTES_PER_ITEM) return;
  throw new SyncQuotaError(
    `Cannot sync item ${JSON.stringify(key)}: ${bytes} bytes exceeds the ${SYNC_QUOTA_BYTES_PER_ITEM}-byte limit.`,
  );
}

interface MonthlyQuotaCandidate {
  bytes: number;
  key: string;
  month: string;
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
): Promise<void> {
  const incomingEntries: Array<[string, unknown]> = Object.entries(items);
  if (incomingEntries.length === 0) return;
  for (let index: number = 0; index < incomingEntries.length; index++) {
    const entry: [string, unknown] = incomingEntries[index] as [string, unknown];
    const key: string = entry[0];
    const value: unknown = entry[1];
    assertSyncItemWithinQuota(key, value);
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
  if (evictions.length > 0) await storage.remove(evictions);
  if (retainedEntries.length > 0) await storage.set(Object.fromEntries(retainedEntries));
}

/**
 * Writes one Sync batch after checking Chrome's authoritative current
 * byte usage. Oldest monthly aggregates are evicted only when needed.
 */
export function setSyncItemsWithinQuota(
  items: Record<string, unknown>,
  storage: chrome.storage.SyncStorageArea = chrome.storage.sync,
): Promise<void> {
  return queueSyncMutation((): Promise<void> => performQuotaCheckedSet(items, storage));
}

/** Serializes removals with quota preflight and writes. */
export function removeSyncItems(
  keys: string[],
  storage: chrome.storage.SyncStorageArea = chrome.storage.sync,
): Promise<void> {
  return queueSyncMutation(async (): Promise<void> => {
    if (keys.length > 0) await storage.remove(keys);
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
