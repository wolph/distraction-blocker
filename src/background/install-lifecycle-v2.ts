/**
 * Install lifecycle events across an all-data clear: capture, durable append, and ordered replay.
 *
 * Chrome delivers `runtime.onInstalled` whenever it likes, including in the middle of a deletion
 * that is erasing the profile the marker describes. Writing the marker there would race the clear,
 * so an event that arrives while the journal exists is captured as a record and appended to the
 * journal instead. The clear replays the records it holds, one at a time, immediately before it
 * finalizes, and only then does the marker say what the last event meant.
 *
 * Every durable step here runs under the shared deletion lease, and every write is one transform
 * with an exact read-back, so a worker that dies between two steps repeats them and converges.
 * Replay is deliberately three writes per intent, in this order: advance the final marker while the
 * intent is still listed, materialize the marker and read it back, then remove the intent. A crash
 * after any one of them replays the same intent to the same value.
 */

import { CoreError } from '../shared/errors';
import {
  type AllDataClearJournalV2,
  appendInstallLifecycleIntent,
  type DataClearJournal,
  type DataClearResetIdsV2,
  type FinalInstallMarkerProjection,
  type InstallLifecycleAppendResult,
  isLegacyAllDataClearJournal,
  type LegacyAllDataClearJournal,
  nextFinalMarkerProjection,
  type PendingInstallLifecycleIntent,
  upgradeLegacyAllDataClearJournal,
} from './data-clear-journal';
import {
  type AllDataClearLease,
  type DataClearLeaseToken,
  transactDataClearJournal,
} from './data-clear-lease';

/** What one submitted lifecycle event did. `applied` means it took the normal marker path. */
export type InstallLifecycleSubmissionV2 = 'appended' | 'applied' | 'capacity';

type StoredJournal = DataClearJournal | LegacyAllDataClearJournal;

const INSTALL_REASONS: ReadonlySet<string> = new Set<string>([
  'install',
  'update',
  'chrome_update',
  'shared_module_update',
]);

/**
 * Turns one `onInstalled` callback into the record the journal stores. Everything it needs is read
 * at the callback, because none of it survives the worker: the reason, the version the manifest
 * reports now, the version Chrome says was there before, and the instant it happened.
 *
 * A `previousVersion` that is not a string is absent, which is what Chrome means by omitting it. A
 * reason no version of the API defines raises here, before anything is written, because a record
 * whose reason cannot be replayed would sit in the journal forever.
 */
export function captureInstallLifecycleIntent(
  details: chrome.runtime.InstalledDetails,
  now: number,
  eventId: string,
  currentVersion: string,
): PendingInstallLifecycleIntent {
  const reason: string = details.reason;
  if (!INSTALL_REASONS.has(reason)) {
    throw new CoreError(
      'invalid-rule',
      `unknown install lifecycle reason ${JSON.stringify(reason)}`,
    );
  }
  const previous: unknown = details.previousVersion;
  return {
    version: 1,
    eventId,
    reason: reason as PendingInstallLifecycleIntent['reason'],
    currentVersion,
    previousVersion: typeof previous === 'string' ? previous : null,
    observedAt: now,
  };
}

/**
 * The one submission point for a captured event. It acquires the lease, so no caller may already
 * hold it, and answers what happened to the event rather than what the journal looked like.
 *
 * With no all-data journal stored, the event takes the normal immediate marker path the caller
 * passes in. With one, the event becomes a durable record and the caller writes nothing: the clear
 * owns the marker until it finishes. A full list keeps every record it already has and reports the
 * capacity failure, which the journal has recorded in its retry error state.
 */
export async function appendOrApplyInstallLifecycle(
  lease: AllDataClearLease,
  intent: PendingInstallLifecycleIntent,
  applyImmediately: () => Promise<void>,
): Promise<InstallLifecycleSubmissionV2> {
  return lease.run(async (token: DataClearLeaseToken): Promise<InstallLifecycleSubmissionV2> => {
    let submission: InstallLifecycleSubmissionV2 = 'applied';
    await transactDataClearJournal(
      lease,
      token,
      (stored: StoredJournal | null): DataClearJournal | 'unchanged' => {
        if (stored === null || stored.scope !== 'all') return 'unchanged';
        // The legacy upgrade and the append are one write, so an event arriving at a journal
        // written before this schema can never leave the upgrade durable without the record.
        const journal: AllDataClearJournalV2 = isLegacyAllDataClearJournal(stored)
          ? upgradeLegacyAllDataClearJournal(stored, freshResetIds(), intent.observedAt)
          : stored;
        const appended: {
          journal: AllDataClearJournalV2;
          result: InstallLifecycleAppendResult;
        } = appendInstallLifecycleIntent(journal, intent);
        submission = appended.result === 'capacity' ? 'capacity' : 'appended';
        return appended.journal;
      },
    );
    if (submission === 'applied') await applyImmediately();
    return submission;
  });
}

/**
 * Replays every stored intent, oldest first, under the token the finalization already holds.
 *
 * One intent at a time, and the marker is advanced in the journal before it is materialized, so the
 * durable projection is always the authority for what the stored marker should be. The intent is
 * removed last. A replay that finds nothing left is complete, which is also what a crashed replay
 * converges on.
 */
export async function replayLifecycleIntentsV2(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
  materializeMarker: (marker: FinalInstallMarkerProjection) => Promise<void>,
): Promise<'complete'> {
  for (;;) {
    const journal: AllDataClearJournalV2 = await readAllDataJournal(lease, token);
    const intent: PendingInstallLifecycleIntent | null = firstIntent(journal);
    if (intent === null) return 'complete';
    const marker: FinalInstallMarkerProjection = nextFinalMarkerProjection(journal, intent);
    await transactDataClearJournal(
      lease,
      token,
      (stored: StoredJournal | null): DataClearJournal => ({
        ...allDataJournalOf(stored),
        finalInstallMarkerProjection: marker,
      }),
    );
    await materializeMarker(marker);
    await transactDataClearJournal(
      lease,
      token,
      (stored: StoredJournal | null): DataClearJournal => {
        const current: AllDataClearJournalV2 = allDataJournalOf(stored);
        return {
          ...current,
          pendingInstallLifecycleIntents: current.pendingInstallLifecycleIntents.filter(
            (candidate: PendingInstallLifecycleIntent): boolean =>
              candidate.eventId !== intent.eventId,
          ),
        };
      },
    );
  }
}

/**
 * The oldest record, by the instant it was observed and then by its event id, which is the order
 * the journal keeps and the order the marker transform requires. A stored list that is out of order
 * is read in the right one rather than trusted.
 */
function firstIntent(journal: AllDataClearJournalV2): PendingInstallLifecycleIntent | null {
  const ordered: PendingInstallLifecycleIntent[] = [...journal.pendingInstallLifecycleIntents].sort(
    (left: PendingInstallLifecycleIntent, right: PendingInstallLifecycleIntent): number =>
      left.observedAt === right.observedAt
        ? left.eventId.localeCompare(right.eventId)
        : left.observedAt - right.observedAt,
  );
  return ordered[0] ?? null;
}

/** One read of the journal under the caller's token, through the same transaction every write uses. */
async function readAllDataJournal(
  lease: AllDataClearLease,
  token: DataClearLeaseToken,
): Promise<AllDataClearJournalV2> {
  const current: DataClearJournal | null = await transactDataClearJournal(
    lease,
    token,
    (): 'unchanged' => 'unchanged',
  );
  return allDataJournalOf(current);
}

function allDataJournalOf(stored: StoredJournal | null): AllDataClearJournalV2 {
  if (stored === null || stored.scope !== 'all' || isLegacyAllDataClearJournal(stored)) {
    throw new CoreError('invalid-rule', 'lifecycle replay needs a version 2 all-data journal');
  }
  return stored;
}

/**
 * The identity a legacy journal gains when an event upgrades it. It is the same pair of fresh
 * UUIDs every other upgrade site allocates, and it is only ever reached by a journal that has none.
 */
function freshResetIds(): DataClearResetIdsV2 {
  return { resetEpoch: crypto.randomUUID(), resetOperationId: crypto.randomUUID() };
}
