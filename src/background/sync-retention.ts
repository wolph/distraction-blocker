import { pruneAndRollup } from './stats-service';
import type { SyncJournal, SyncWriter } from './sync-writer';

function effectiveSyncState(
  stored: Record<string, unknown>,
  pending: SyncJournal,
): Record<string, unknown> {
  const effective: Record<string, unknown> = { ...stored, ...pending.sets };
  for (const key of pending.removes) delete effective[key];
  return effective;
}

function applyPruneToPending(
  pending: SyncJournal,
  plan: ReturnType<typeof pruneAndRollup>,
): SyncJournal {
  const sets: Record<string, unknown> = { ...pending.sets };
  const removes: Set<string> = new Set(pending.removes);
  for (const key of plan.remove) {
    delete sets[key];
    removes.add(key);
  }
  for (const [key, value] of Object.entries(plan.set)) {
    sets[key] = value;
    removes.delete(key);
  }
  return { sets, removes: [...removes] };
}

/**
 * Folds pending expired dailies into monthly values before SyncWriter flushes.
 * The writer keeps the read, transform, and durable journal replacement ahead
 * of every later flush.
 */
export function compactPendingSyncRetention(
  writer: SyncWriter,
  deviceId: string,
  retentionDays: number,
  now: number,
  loadStored: () => Promise<Record<string, unknown>>,
): Promise<void> {
  return writer.transformPending(
    loadStored,
    (stored: Record<string, unknown>, pending: SyncJournal): SyncJournal => {
      const effective: Record<string, unknown> = effectiveSyncState(stored, pending);
      const plan: ReturnType<typeof pruneAndRollup> = pruneAndRollup(
        deviceId,
        effective,
        retentionDays,
        now,
      );
      return applyPruneToPending(pending, plan);
    },
  );
}
