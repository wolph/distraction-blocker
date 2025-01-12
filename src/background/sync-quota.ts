export const SYNC_QUOTA_BYTES_PER_ITEM: number = 8_192;

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
