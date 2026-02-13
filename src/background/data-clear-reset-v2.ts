/**
 * The browser-reset phase of an all-data clear, and the finalization that ends it.
 *
 * Two rules shape this file. Every durable change is one transform under the caller's deletion
 * token, because the journal is the only authority for reset progress and two concurrent
 * transactions under one token are refused: a resolver pass folds everything it learned into a
 * single write. And nothing here materializes anything: Policy Storage has already written the
 * runtime, the setup record, and the clean install marker from the journal's own projections, so an
 * attempt that finds them different repairs nothing and asks for the next dispatch instead.
 *
 * The bounded resolver, the ten second deadline, and the twelve attempt retry schedule are the ones
 * the enforcement sweep and the cleanup journals already use. This file parameterizes them for the
 * reset rather than restating them.
 */

import { CoreError } from '../shared/errors';
import { exactDataEqual } from '../shared/exact-data';
import { LOCAL_DATA_CLEAR_JOURNAL } from '../shared/storage-keys';
import { type AlarmPortsV2, createAlarmWithReadBackV2, DATA_CLEAR_RETRY_ALARM } from './alarms-v2';
import {
  beginManualCleanupBatchV2,
  documentCommandKeyV2,
  recordCleanupAttemptFailureV2,
} from './cleanup-progress-v2';
import type { EpochResetOutcomeV2 } from './content-transport-v2';
import { type ContentTransportPortsV2, sendEpochResetCommand } from './content-transport-v2';
import {
  type AllDataClearJournalV2,
  DATA_CLEAR_RESET_DEADLINE_MS,
  type DataClearDeferredTarget,
  type DataClearJournal,
  type DataClearResetExclusion,
  type DataClearResetProgress,
  type LegacyAllDataClearJournal,
  MAX_DATA_CLEAR_RESOLVER_PASSES,
  parseDataClearJournal,
} from './data-clear-journal';
import {
  type AllDataClearLease,
  type DataClearLeaseToken,
  transactDataClearJournal,
} from './data-clear-lease';
import type { DocumentEpochResetAck, FrozenEpochResetCommand } from './enforcement-persistence-v2';
import {
  type EnforcementTargetPortsV2,
  enumerateEnforcementTargetsV2,
} from './enforcement-targets-v2';
import { buildFrozenEpochResetCommandV2 } from './overlay-view-v2';
import type { CleanupEnforcementTarget } from './runtime-v2-types';

/** Every seam the reset needs that it is not allowed to own. */
export interface BrowserResetPortsV2 {
  lease: AllDataClearLease;
  now(): number;
  newId(): string;
  targets: EnforcementTargetPortsV2;
  transport: ContentTransportPortsV2;
  alarms: AlarmPortsV2;
  /** The three values Policy Storage materialized from this journal's projections. */
  readMaterialized(): Promise<{ runtime: unknown; setup: unknown; installMarker: unknown }>;
  deviceIdExists(): Promise<boolean>;
  /** The clean-profile identity regeneration, legal only after the clean marker reads back. */
  ensureDeviceId(): Promise<string>;
  /** Main's adapter over the install-lifecycle replay, run under the token it is given. */
  replayLifecycleIntents(token: DataClearLeaseToken): Promise<'complete' | 'failed'>;
  reportError(error: unknown): void;
}

/** One attempt ends stable, with its next attempt scheduled, or with the batch exhausted. */
export type BrowserResetAttemptResultV2 = 'stable' | 'retry-scheduled' | 'exhausted';

export type AllDataClearFinalizationV2 = 'removed' | 'not-finalizable' | 'retry-scheduled';

/** The reset progress an attempt starts from, which is the shape a restart resumes on. */
const FRESH_ATTEMPT: Pick<
  DataClearResetProgress,
  'resolverPassCount' | 'targetGeneration' | 'stablePasses'
> = { resolverPassCount: 0, targetGeneration: null, stablePasses: 0 };

/**
 * One browser-reset attempt. It refuses to start on evidence that does not match the journal, runs
 * the bounded resolver, and answers what the caller owes next. Nothing outside the journal records
 * its progress, so a worker that dies mid-attempt resumes on exactly what it had written.
 */
export async function runBrowserResetAttemptV2(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
): Promise<BrowserResetAttemptResultV2> {
  const journal: AllDataClearJournalV2 = await resetJournal(ports);
  if (!(await materializationMatches(ports, journal))) {
    return failAttempt(ports, token, 'materialization-mismatch');
  }
  await ports.ensureDeviceId();
  await beginAttempt(ports, token);
  for (;;) {
    const current: AllDataClearJournalV2 = await resetJournal(ports);
    const progress: DataClearResetProgress = resetProgressOf(current);
    const started: number = progress.attemptStartedAt ?? ports.now();
    if (ports.now() >= started + DATA_CLEAR_RESET_DEADLINE_MS) {
      return failAttempt(ports, token, 'reset-deadline');
    }
    if (progress.resolverPassCount >= MAX_DATA_CLEAR_RESOLVER_PASSES) {
      return failAttempt(ports, token, 'reset-passes-exhausted');
    }
    const pass: PassOutcomeV2 = await runResolverPass(ports, token, progress);
    if (pass.kind === 'failed') return failAttempt(ports, token, pass.detail);
    if (pass.kind === 'stable') return 'stable';
  }
}

/**
 * Ends the clear. It acquires the lease once and passes that token down, rereads every piece of
 * evidence before it replays anything, and answers `removed` only when the journal key is gone on a
 * read after the removal. Anything short of that leaves the journal exactly where it was.
 */
export async function finalizeAllDataClearV2(
  ports: BrowserResetPortsV2,
): Promise<AllDataClearFinalizationV2> {
  return ports.lease.run(
    async (token: DataClearLeaseToken): Promise<AllDataClearFinalizationV2> => {
      const journal: AllDataClearJournalV2 = await resetJournal(ports);
      if (!(await finalizable(ports, journal))) return 'not-finalizable';
      if ((await ports.replayLifecycleIntents(token)) === 'failed') {
        return scheduledOrExhausted(await failAttempt(ports, token, 'lifecycle-replay-failed'));
      }
      const replayed: AllDataClearJournalV2 = await resetJournal(ports);
      if (replayed.pendingInstallLifecycleIntents.length > 0) {
        return scheduledOrExhausted(await failAttempt(ports, token, 'lifecycle-intents-remain'));
      }
      if (!(await finalMarkerMatches(ports, replayed))) {
        return scheduledOrExhausted(await failAttempt(ports, token, 'final-marker-mismatch'));
      }
      ports.targets.readTargetGeneration();
      try {
        await transactDataClearJournal(ports.lease, token, (): null => null);
      } catch (error: unknown) {
        // A removal the storage layer would not confirm is a failed attempt, not a thrown clear.
        ports.reportError(error);
        return scheduledOrExhausted(await failAttempt(ports, token, 'journal-not-removed'));
      }
      // The read after the removal is the only proof. The marker was written before it, so an
      // absent journal beside a clean marker is the completed state a boot classifies.
      if ((await storedJournal()) !== null) {
        return scheduledOrExhausted(await failAttempt(ports, token, 'journal-not-removed'));
      }
      return 'removed';
    },
  );
}

/**
 * The manual retry a user asks for. It keeps the reset epoch and every projection, because those
 * are the identity of this clear, and replaces the operation the documents were asked under.
 */
export async function retryBrowserResetV2(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
): Promise<'ok' | 'retry-not-available'> {
  const stored: DataClearJournal | null = await storedJournal();
  if (stored === null || stored.scope !== 'all' || stored.phase !== 'browser-reset') {
    return 'retry-not-available';
  }
  const operationId: string = ports.newId();
  const at: number = ports.now();
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      return {
        ...journal,
        resetOperationId: operationId,
        resetProgress: {
          ...progress,
          ...FRESH_ATTEMPT,
          attemptStartedAt: null,
          commands: reissuedCommands(progress.commands, journal.resetEpoch, operationId),
          acknowledgements: {},
        },
        retry: beginManualCleanupBatchV2(journal.retry, at),
      };
    },
  );
  await rearmResetAlarm(ports, token);
  return 'ok';
}

/**
 * An exhausted batch is still a journal that stays where it is, and finalization reports the same
 * `retry-scheduled` for it: the public state reads the exhaustion off the journal's own retry.
 */
function scheduledOrExhausted(result: 'retry-scheduled' | 'exhausted'): AllDataClearFinalizationV2 {
  void result;
  return 'retry-scheduled';
}

/** One resolver pass: what it decided, and nothing about how it wrote it. */
type PassOutcomeV2 = { kind: 'stable' } | { kind: 'continue' } | { kind: 'failed'; detail: string };

/** What one pass learned about every target it reached, folded into a single durable write. */
interface PassRecordV2 {
  targets: Record<string, CleanupEnforcementTarget>;
  commands: Record<string, FrozenEpochResetCommand>;
  acknowledgements: Record<string, DocumentEpochResetAck>;
  exclusions: DataClearResetExclusion[];
  deferred: DataClearDeferredTarget[];
  reachable: number;
  acknowledgedNow: number;
  failure: string | null;
}

/**
 * Sends this pass's reset to every enforceable target, then writes the pass count, everything the
 * pass learned, and the stability it reached, in one transform. The pass count is durable before
 * enumeration, so a crash costs a pass rather than repeating one.
 */
async function runResolverPass(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
  progress: DataClearResetProgress,
): Promise<PassOutcomeV2> {
  await countPass(ports, token);
  const journal: AllDataClearJournalV2 = await resetJournal(ports);
  const record: PassRecordV2 = await sendPass(ports, journal);
  if (record.failure !== null) return { kind: 'failed', detail: record.failure };
  const generation: number = ports.targets.readTargetGeneration();
  // The first pass adopts the generation rather than counting it as a change: the attempt has no
  // earlier reading to have been invalidated, and a change costs a pass out of three.
  const changed: boolean =
    progress.targetGeneration !== null && progress.targetGeneration !== generation;
  const settled: boolean = record.reachable > 0 || record.deferred.length === 0;
  const stable: boolean = !changed && settled && record.acknowledgedNow === record.reachable;
  const stablePasses: 0 | 1 | 2 = changed ? 0 : nextStablePasses(progress.stablePasses, stable);
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const stored: AllDataClearJournalV2 = browserResetOf(current);
      const held: DataClearResetProgress = resetProgressOf(stored);
      return {
        ...stored,
        resetProgress: {
          ...held,
          targetGeneration: generation,
          stablePasses,
          targets: { ...held.targets, ...record.targets },
          commands: { ...held.commands, ...record.commands },
          acknowledgements: { ...held.acknowledgements, ...record.acknowledgements },
          exclusions: record.exclusions,
          deferredUnreachable: record.deferred,
        },
      };
    },
  );
  return stablePasses === 2 ? { kind: 'stable' } : { kind: 'continue' };
}

/** Two consecutive stable passes end the attempt, and anything else restarts the count. */
function nextStablePasses(current: 0 | 1 | 2, stable: boolean): 0 | 1 | 2 {
  if (!stable) return 0;
  return current === 0 ? 1 : 2;
}

/**
 * The browser half of one pass. Every enforceable target is frozen into a command and sent under
 * the journal's own epoch and operation, and only an exact acknowledgement counts. A rejected or
 * mismatched answer fails the attempt on the spot: it is never deferred and never excluded.
 */
async function sendPass(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<PassRecordV2> {
  const record: PassRecordV2 = {
    targets: {},
    commands: {},
    acknowledgements: {},
    exclusions: [],
    deferred: [],
    reachable: 0,
    acknowledgedNow: 0,
    failure: null,
  };
  for (const target of await enumerateEnforcementTargetsV2(ports.targets)) {
    if (target.kind === 'outside') continue;
    if (target.kind === 'known-unsupported') {
      record.exclusions.push({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        reason: 'known-unsupported',
      });
      continue;
    }
    if (target.kind === 'changed') {
      // A target the resolver could not name a document for is deferred, not excluded: it is a
      // page that may still answer, and the bounded passes are what decide that.
      record.deferred.push({
        tabId: target.tabId,
        documentId: null,
        expectedUrl: target.url,
        reason: 'no-document-id',
      });
      continue;
    }
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const command: FrozenEpochResetCommand = buildFrozenEpochResetCommandV2({
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
      operationId: journal.resetOperationId,
      enforcementEpoch: journal.resetEpoch,
    });
    record.targets[key] = {
      tabId: target.tabId,
      documentId: target.documentId,
      expectedUrl: target.url,
    };
    record.commands[key] = command;
    record.reachable += 1;
    const outcome: EpochResetOutcomeV2 = await sendEpochResetCommand(ports.transport, command);
    if (outcome.kind === 'reset' && exactAck(outcome.ack, command)) {
      record.acknowledgements[key] = outcome.ack;
      record.acknowledgedNow += 1;
      continue;
    }
    if (outcome.kind === 'closed') {
      record.reachable -= 1;
      delete record.targets[key];
      delete record.commands[key];
      record.exclusions.push({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        reason: 'closed',
      });
      continue;
    }
    if (outcome.kind === 'no-receiver') {
      record.reachable -= 1;
      record.deferred.push({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        reason: 'no-receiver',
      });
      continue;
    }
    record.failure =
      outcome.kind === 'rejected'
        ? `epoch-reset-rejected on tab ${target.tabId}`
        : `reset acknowledgement mismatch on tab ${target.tabId}`;
    return record;
  }
  return record;
}

/** An acknowledgement counts only when it answers this command, on this document, at this URL. */
function exactAck(ack: DocumentEpochResetAck, command: FrozenEpochResetCommand): boolean {
  return (
    ack.operationId === command.operationId &&
    ack.enforcementEpoch === command.enforcementEpoch &&
    ack.tabId === command.tabId &&
    ack.documentId === command.documentId &&
    ack.url === command.expectedUrl
  );
}

/** The attempt start, durable before the first pass so a restart resumes inside its budget. */
async function beginAttempt(ports: BrowserResetPortsV2, token: DataClearLeaseToken): Promise<void> {
  const at: number = ports.now();
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      return {
        ...journal,
        resetProgress: { ...resetProgressOf(journal), ...FRESH_ATTEMPT, attemptStartedAt: at },
      };
    },
  );
}

/** The pass count is durable before the pass runs, so a crash inside one costs that pass. */
async function countPass(ports: BrowserResetPortsV2, token: DataClearLeaseToken): Promise<void> {
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      return {
        ...journal,
        resetProgress: {
          ...progress,
          resolverPassCount: nextPassCount(progress.resolverPassCount),
        },
      };
    },
  );
}

function nextPassCount(current: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 {
  if (current >= MAX_DATA_CLEAR_RESOLVER_PASSES) {
    throw new CoreError('invalid-rule', 'the browser reset resolver is past its pass bound');
  }
  return (current + 1) as 0 | 1 | 2 | 3;
}

/**
 * Records one failed attempt and brings the retry alarm in line with it, which is the same loop the
 * cleanup journals run: an alarm the browser refuses is one more failure, so the schedule ends
 * either with an alarm that read back or with an exhausted batch and no alarm at all.
 */
async function failAttempt(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
  detail: string,
): Promise<'retry-scheduled' | 'exhausted'> {
  const at: number = ports.now();
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      return { ...journal, retry: recordCleanupAttemptFailureV2(journal.retry, at, detail) };
    },
  );
  return rearmResetAlarm(ports, token);
}

/** Brings the retry alarm in line with the journal's own `nextAttemptAt`. */
async function rearmResetAlarm(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
): Promise<'retry-scheduled' | 'exhausted'> {
  for (;;) {
    const journal: AllDataClearJournalV2 = await resetJournal(ports);
    const scheduled: number | null = journal.retry.nextAttemptAt;
    if (scheduled === null) return 'exhausted';
    if (await createAlarmWithReadBackV2(ports.alarms, DATA_CLEAR_RETRY_ALARM, scheduled)) {
      return 'retry-scheduled';
    }
    const at: number = ports.now();
    await transactDataClearJournal(
      ports.lease,
      token,
      (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
        const stored: AllDataClearJournalV2 = browserResetOf(current);
        return {
          ...stored,
          retry: recordCleanupAttemptFailureV2(
            stored.retry,
            at,
            'the browser reset could not schedule its retry alarm',
          ),
        };
      },
    );
  }
}

/** Every command carries the new operation, and nothing else about it changes. */
function reissuedCommands(
  commands: Record<string, FrozenEpochResetCommand>,
  enforcementEpoch: string,
  operationId: string,
): Record<string, FrozenEpochResetCommand> {
  const reissued: Record<string, FrozenEpochResetCommand> = {};
  for (const [key, command] of Object.entries(commands)) {
    reissued[key] = buildFrozenEpochResetCommandV2({
      tabId: command.tabId,
      documentId: command.documentId,
      expectedUrl: command.expectedUrl,
      operationId,
      enforcementEpoch,
    });
  }
  return reissued;
}

/** The three values this journal already materialized have to be exactly what it projected. */
async function materializationMatches(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<boolean> {
  const materialized: { runtime: unknown; setup: unknown; installMarker: unknown } =
    await ports.readMaterialized();
  return (
    exactDataEqual(materialized.runtime, journal.runtimeProjection) &&
    exactDataEqual(materialized.setup, journal.setupProjection) &&
    exactDataEqual(materialized.installMarker, journal.installMarkerProjection)
  );
}

/** The final marker read-back, which replay leaves behind and finalization requires. */
async function finalMarkerMatches(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<boolean> {
  const materialized: { installMarker: unknown } = await ports.readMaterialized();
  return exactDataEqual(materialized.installMarker, journal.finalInstallMarkerProjection);
}

/**
 * Everything finalization requires before it replays anything: the runtime and setup evidence, a
 * reset that reached two stable passes, and a device identity the clean profile already has.
 */
async function finalizable(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<boolean> {
  const materialized: { runtime: unknown; setup: unknown; installMarker: unknown } =
    await ports.readMaterialized();
  if (!exactDataEqual(materialized.runtime, journal.runtimeProjection)) return false;
  if (!exactDataEqual(materialized.setup, journal.setupProjection)) return false;
  if (!exactDataEqual(materialized.installMarker, journal.finalInstallMarkerProjection)) {
    return false;
  }
  if (resetProgressOf(journal).stablePasses !== 2) return false;
  return await ports.deviceIdExists();
}

/** The stored journal, whatever its scope. A value no parser accepts raises through the reader. */
async function storedJournal(): Promise<DataClearJournal | null> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(LOCAL_DATA_CLEAR_JOURNAL);
  const raw: unknown = stored[LOCAL_DATA_CLEAR_JOURNAL];
  if (raw === undefined) return null;
  const parsed: DataClearJournal | null = parseDataClearJournal(raw) as DataClearJournal | null;
  if (parsed === null) {
    throw new CoreError('storage', 'the stored data clear journal failed parsing');
  }
  return parsed;
}

async function resetJournal(ports: BrowserResetPortsV2): Promise<AllDataClearJournalV2> {
  void ports;
  return browserResetOf(await storedJournal());
}

/** Every entry point here needs an all-data journal that has reached browser reset. */
function browserResetOf(
  current: DataClearJournal | LegacyAllDataClearJournal | null,
): AllDataClearJournalV2 {
  if (
    current === null ||
    current.scope !== 'all' ||
    current.phase !== 'browser-reset' ||
    !('version' in current)
  ) {
    throw new CoreError('invalid-rule', 'this step needs an all-data journal at browser reset');
  }
  return current;
}

function resetProgressOf(journal: AllDataClearJournalV2): DataClearResetProgress {
  if (journal.resetProgress === null) {
    throw new CoreError('invalid-rule', 'a browser-reset journal carries its reset progress');
  }
  return journal.resetProgress;
}
