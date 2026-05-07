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
import type { CleanupEnforcementTarget, RuntimeStateV2 } from './runtime-v2-types';

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
  /**
   * The caller's own in-memory reset, run while the lease is still held, so no later operation can
   * begin against a caller that is half reset.
   */
  afterRemoval?(runtime: RuntimeStateV2): Promise<void>;
  reportError(error: unknown): void;
}

/** One attempt ends stable, with its next attempt scheduled, or with the batch exhausted. */
export type BrowserResetAttemptResultV2 = 'stable' | 'retry-scheduled' | 'exhausted';

export type AllDataClearFinalizationV2 =
  | 'removed'
  | 'not-finalizable'
  | 'retry-scheduled'
  | 'exhausted';

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
  const journal: AllDataClearJournalV2 = await resetJournal();
  if (!(await materializationMatches(ports, journal))) {
    return failAttempt(ports, token, 'materialization-mismatch');
  }
  // A restart resumes the attempt the journal already owns. Its budget is checked before the
  // identity and before any send, so a wake that arrives past the deadline or past the third
  // reserved pass advances the retry schedule and produces no effect at all.
  const spent: string | null = attemptBudgetSpent(resetProgressOf(journal), ports.now());
  if (spent !== null) return failAttempt(ports, token, spent);
  await ports.ensureDeviceId();
  await beginAttempt(ports, token);
  for (;;) {
    const current: AllDataClearJournalV2 = await resetJournal();
    const progress: DataClearResetProgress = resetProgressOf(current);
    const remaining: string | null = attemptBudgetSpent(progress, ports.now());
    if (remaining !== null) return failAttempt(ports, token, remaining);
    const pass: PassOutcomeV2 = await runResolverPass(ports, token, progress);
    if (pass.kind === 'failed') return failAttempt(ports, token, pass.detail);
    if (pass.kind === 'stable') return 'stable';
  }
}

/**
 * What an attempt has already spent of the budget the journal made durable, or null while it still
 * has both time and a pass left. An attempt that has not started yet owns its whole budget.
 */
function attemptBudgetSpent(progress: DataClearResetProgress, now: number): string | null {
  const started: number | null = progress.attemptStartedAt;
  if (started === null) return null;
  if (now >= started + DATA_CLEAR_RESET_DEADLINE_MS) return 'reset-deadline';
  if (progress.resolverPassCount >= MAX_DATA_CLEAR_RESOLVER_PASSES) {
    return 'reset-passes-exhausted';
  }
  return null;
}

/**
 * Ends the clear. It acquires the lease once and passes that token down, rereads every piece of
 * evidence before it replays anything, and answers `removed` only when the journal key is gone on a
 * read after the removal. Anything short of that leaves the journal exactly where it was.
 */
export async function finalizeAllDataClearV2(
  ports: BrowserResetPortsV2,
): Promise<AllDataClearFinalizationV2> {
  // Finalization acquires the lease rather than checking whether anyone holds it. `held()` counts
  // every queued operation, so refusing on it also refuses a lifecycle append that legitimately
  // queued ahead of this finalization, which spec 1327 requires to join the ordered replay. The
  // reentrancy the acquisition itself cannot survive is refused by the lease's own guard.
  return ports.lease.run(
    async (token: DataClearLeaseToken): Promise<AllDataClearFinalizationV2> => {
      const journal: AllDataClearJournalV2 = await resetJournal();
      const projection: RuntimeStateV2 | null = journal.runtimeProjection;
      if (projection === null) throw new Error('browser reset requires a runtime projection');
      const missing: string | null = await missingEvidence(ports, journal);
      if (missing !== null) {
        // Answering `not-finalizable` and recording nothing is how a clear stops with the barrier
        // shut and no wake coming. The answer stays distinguishable and the reason becomes durable,
        // so the retry the journal schedules brings the next dispatch back. A batch with nothing
        // left to schedule says so instead: there is no wake for the caller to wait on.
        const recorded: 'retry-scheduled' | 'exhausted' = await failAttempt(ports, token, missing);
        return recorded === 'exhausted' ? 'exhausted' : 'not-finalizable';
      }
      if ((await ports.replayLifecycleIntents(token)) === 'failed') {
        return scheduledOrExhausted(await failAttempt(ports, token, 'lifecycle-replay-failed'));
      }
      const replayed: AllDataClearJournalV2 = await resetJournal();
      if (replayed.pendingInstallLifecycleIntents.length > 0) {
        return scheduledOrExhausted(await failAttempt(ports, token, 'lifecycle-intents-remain'));
      }
      if (!(await finalMarkerMatches(ports, replayed))) {
        return scheduledOrExhausted(await failAttempt(ports, token, 'final-marker-mismatch'));
      }
      // Spec 1353 requires the final generation reread to be unchanged, so it is compared rather
      // than merely performed: a target set that moved between the last stable pass and this
      // removal is a proof that no longer holds.
      const generation: number = ports.targets.readTargetGeneration();
      if (generation !== resetProgressOf(replayed).targetGeneration) {
        // The stable passes were established against a target set that has moved, so they are
        // spent with the refusal. Re-reading the number would refuse forever: it is a per-worker
        // counter, so a restart never matches, and only a new attempt writes it again.
        return scheduledOrExhausted(
          await failAttempt(ports, token, 'target-generation-changed', true),
        );
      }
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
      // The caller's own reset happens while the lease is still held, so nothing can begin a new
      // clear against a caller that is half reset.
      await ports.afterRemoval?.(structuredClone(projection));
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
 * An exhausted batch leaves no alarm behind, so a caller told `retry-scheduled` for one would be
 * acting on a wake that is never coming. The journal stays where it is either way.
 */
function scheduledOrExhausted(result: 'retry-scheduled' | 'exhausted'): AllDataClearFinalizationV2 {
  return result;
}

/** One resolver pass: what it decided, and nothing about how it wrote it. */
type PassOutcomeV2 = { kind: 'stable' } | { kind: 'continue' } | { kind: 'failed'; detail: string };

/** One target this pass will send to, under the exact command it is sent with. */
interface FrozenTargetV2 {
  key: string;
  target: CleanupEnforcementTarget;
  command: FrozenEpochResetCommand;
}

/** What enumeration decided, before anything was written and before anything was sent. */
interface PassPlanV2 {
  frozen: FrozenTargetV2[];
  exclusions: DataClearResetExclusion[];
  deferred: DataClearDeferredTarget[];
}

/** What the sends answered. Exclusions and deferrals grow here as documents turn out to be gone. */
interface SendRecordV2 {
  acknowledgements: Record<string, DocumentEpochResetAck>;
  exclusions: DataClearResetExclusion[];
  deferred: DataClearDeferredTarget[];
  reachable: number;
  acknowledgedNow: number;
  failure: string | null;
  /** The key whose frozen command the document refused as not describing the page it is on. */
  staleKey: string | null;
}

/**
 * One resolver pass, in the order the spec fixes: enumerate and classify, make the pass count and
 * every exact command durable, send only what is durable, then fold the answers in one transform.
 *
 * The freeze before the send is the point. A reset issued under a command no journal records is a
 * browser effect nothing can account for after a crash, and the retry would re-derive a different
 * command for a document whose URL had drifted.
 */
async function runResolverPass(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
  progress: DataClearResetProgress,
): Promise<PassOutcomeV2> {
  const journal: AllDataClearJournalV2 = await resetJournal();
  const plan: PassPlanV2 = await planPass(ports, journal);
  await freezePass(ports, token, plan);
  const record: SendRecordV2 = await sendFrozen(ports, plan);
  if (record.failure !== null) {
    if (record.staleKey !== null) await forgetFrozenTarget(ports, token, record.staleKey);
    return { kind: 'failed', detail: record.failure };
  }
  const generation: number = ports.targets.readTargetGeneration();
  // The first pass adopts the generation rather than counting it as a change: the attempt has no
  // earlier reading to have been invalidated, and a change costs a pass out of three.
  const changed: boolean =
    progress.targetGeneration !== null && progress.targetGeneration !== generation;
  // A deferral never blocks stability. Spec 1345 says an unreachable document does not keep deleted
  // data alive, and spec 1355 is why that is safe: it receives its reset when it next loads. A pass
  // with nothing reachable at all is settled, which is the ordinary state of a profile whose tabs
  // were open before the extension was installed.
  const stable: boolean = !changed && record.acknowledgedNow === record.reachable;
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
          acknowledgements: { ...held.acknowledgements, ...record.acknowledgements },
          // Exclusions and deferrals are this pass's picture rather than a running log: a target
          // that is gone from the reread is gone from the record with it.
          exclusions: [...plan.exclusions, ...record.exclusions],
          deferredUnreachable: [...plan.deferred, ...record.deferred],
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
 * Drops one target's frozen command, its target record, and any acknowledgement under it, so the
 * next pass derives a command from what the document is rather than from what it was.
 */
async function forgetFrozenTarget(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
  key: string,
): Promise<void> {
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      const targets: Record<string, CleanupEnforcementTarget> = { ...progress.targets };
      const commands: Record<string, FrozenEpochResetCommand> = { ...progress.commands };
      const acknowledgements: Record<string, DocumentEpochResetAck> = {
        ...progress.acknowledgements,
      };
      delete targets[key];
      delete commands[key];
      delete acknowledgements[key];
      return { ...journal, resetProgress: { ...progress, targets, commands, acknowledgements } };
    },
  );
}

/**
 * Enumerates the browser and decides what each target is, without writing or sending anything. A
 * target the journal already froze a command for keeps that exact command, so a document whose URL
 * drifted between attempts is retried under the command it was first issued.
 */
async function planPass(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<PassPlanV2> {
  const held: Record<string, FrozenEpochResetCommand> = resetProgressOf(journal).commands;
  const plan: PassPlanV2 = { frozen: [], exclusions: [], deferred: [] };
  for (const target of await enumerateEnforcementTargetsV2(ports.targets)) {
    if (target.kind === 'outside') continue;
    if (target.kind === 'known-unsupported') {
      plan.exclusions.push({
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
      plan.deferred.push({
        tabId: target.tabId,
        documentId: null,
        expectedUrl: target.url,
        reason: 'no-document-id',
      });
      continue;
    }
    const key: string = documentCommandKeyV2(target.tabId, target.documentId);
    const command: FrozenEpochResetCommand =
      held[key] ??
      buildFrozenEpochResetCommandV2({
        tabId: target.tabId,
        documentId: target.documentId,
        expectedUrl: target.url,
        operationId: journal.resetOperationId,
        enforcementEpoch: journal.resetEpoch,
      });
    // The target record is the command's own fields, not the live reading. A document whose URL
    // drifted under a frozen command is retried under the command it was issued, and the journal
    // says the same thing about it in both maps.
    plan.frozen.push({
      key,
      target: {
        tabId: command.tabId,
        documentId: command.documentId,
        expectedUrl: command.expectedUrl,
      },
      command,
    });
  }
  return plan;
}

/**
 * Reserves the pass and makes every command of it durable, in one transform, before a single send
 * goes out. The pass count belongs here too: a crash inside the sends costs that pass rather than
 * repeating it.
 */
async function freezePass(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
  plan: PassPlanV2,
): Promise<void> {
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      const targets: Record<string, CleanupEnforcementTarget> = { ...progress.targets };
      const commands: Record<string, FrozenEpochResetCommand> = { ...progress.commands };
      for (const frozen of plan.frozen) {
        targets[frozen.key] = frozen.target;
        commands[frozen.key] = frozen.command;
      }
      return {
        ...journal,
        resetProgress: {
          ...progress,
          resolverPassCount: nextPassCount(progress.resolverPassCount),
          targets,
          commands,
        },
      };
    },
  );
}

/**
 * Sends every command this pass froze. Only an acknowledgement that answers the exact command
 * counts. A rejection or a mismatch fails the attempt on the spot: it is never deferred and never
 * excluded.
 */
async function sendFrozen(ports: BrowserResetPortsV2, plan: PassPlanV2): Promise<SendRecordV2> {
  const record: SendRecordV2 = {
    acknowledgements: {},
    exclusions: [],
    deferred: [],
    reachable: 0,
    acknowledgedNow: 0,
    failure: null,
    staleKey: null,
  };
  for (const frozen of plan.frozen) {
    record.reachable += 1;
    const outcome: EpochResetOutcomeV2 = await sendEpochResetCommand(
      ports.transport,
      frozen.command,
    );
    if (outcome.kind === 'reset' && exactAck(outcome.ack, frozen.command)) {
      record.acknowledgements[frozen.key] = outcome.ack;
      record.acknowledgedNow += 1;
      continue;
    }
    if (outcome.kind === 'closed') {
      record.reachable -= 1;
      record.exclusions.push({
        tabId: frozen.target.tabId,
        documentId: frozen.target.documentId,
        expectedUrl: frozen.target.expectedUrl,
        reason: 'closed',
      });
      continue;
    }
    if (outcome.kind === 'no-receiver') {
      record.reachable -= 1;
      record.deferred.push({
        tabId: frozen.target.tabId,
        documentId: frozen.target.documentId,
        expectedUrl: frozen.target.expectedUrl,
        reason: 'no-receiver',
      });
      continue;
    }
    record.failure =
      outcome.kind === 'rejected'
        ? `epoch-reset-rejected on tab ${frozen.target.tabId}`
        : `reset acknowledgement mismatch on tab ${frozen.target.tabId}`;
    // Only an answer that disputes the address invalidates the address this command froze, which
    // is what a route change inside one document produces: the document ID survives and the URL
    // does not. That key's command is dropped so the next pass freezes the document again at the
    // URL it is really on, which keeps "frozen before send" intact and gives the failure an exit.
    // Every other mismatch, a lost response or an answer no parser accepts included, disputes
    // nothing about the address, so the durable record it would throw away is kept.
    if (outcome.kind === 'mismatch' && outcome.field === 'observedUrl') {
      record.staleKey = frozen.key;
    }
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

/**
 * The attempt start, durable before the first pass so a restart resumes inside its budget. An
 * attempt that already has a start keeps it, along with the passes it reserved: restamping it from
 * the current clock is what would let an evicted worker send resets forever without ever spending
 * one of its twelve attempts.
 */
async function beginAttempt(ports: BrowserResetPortsV2, token: DataClearLeaseToken): Promise<void> {
  const at: number = ports.now();
  await transactDataClearJournal(
    ports.lease,
    token,
    (
      current: DataClearJournal | LegacyAllDataClearJournal | null,
    ): DataClearJournal | 'unchanged' => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      if (progress.attemptStartedAt !== null) return 'unchanged';
      return {
        ...journal,
        resetProgress: { ...progress, ...FRESH_ATTEMPT, attemptStartedAt: at },
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
  spendStability: boolean = false,
): Promise<'retry-scheduled' | 'exhausted'> {
  // Bootstrap resumes the reset for any journal it finds, an exhausted one included, so a batch
  // with nothing left to schedule answers rather than raising out of the entry point.
  if (batchExhausted(await resetJournal())) return 'exhausted';
  const at: number = ports.now();
  await transactDataClearJournal(
    ports.lease,
    token,
    (current: DataClearJournal | LegacyAllDataClearJournal | null): DataClearJournal => {
      const journal: AllDataClearJournalV2 = browserResetOf(current);
      const progress: DataClearResetProgress = resetProgressOf(journal);
      return {
        ...journal,
        // The attempt that failed is over, and the record has to say so. A start left behind is
        // indistinguishable from a crash inside an attempt, and every retry delay is longer than
        // the deadline, so the next wake would inherit a spent budget and do nothing at all.
        resetProgress: {
          ...progress,
          attemptStartedAt: null,
          resolverPassCount: 0,
          stablePasses: spendStability ? 0 : progress.stablePasses,
        },
        retry: recordCleanupAttemptFailureV2(journal.retry, at, detail),
      };
    },
  );
  return rearmResetAlarm(ports, token);
}

/** A batch that has failed with nothing left to schedule. Only a manual retry moves it. */
function batchExhausted(journal: AllDataClearJournalV2): boolean {
  return journal.retry.lastError !== null && journal.retry.nextAttemptAt === null;
}

/** Brings the retry alarm in line with the journal's own `nextAttemptAt`. */
async function rearmResetAlarm(
  ports: BrowserResetPortsV2,
  token: DataClearLeaseToken,
): Promise<'retry-scheduled' | 'exhausted'> {
  for (;;) {
    const journal: AllDataClearJournalV2 = await resetJournal();
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

/**
 * The three values this journal already materialized have to be exactly what it projects now. The
 * marker is compared against the final projection rather than the frozen clean one, because a
 * replay that advanced the final projection made the live marker legitimately different from the
 * clean projection, and every attempt after it would otherwise record a mismatch until the batch
 * exhausted.
 */
async function materializationMatches(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<boolean> {
  const materialized: { runtime: unknown; setup: unknown; installMarker: unknown } =
    await ports.readMaterialized();
  return (
    exactDataEqual(materialized.runtime, journal.runtimeProjection) &&
    exactDataEqual(materialized.setup, journal.setupProjection) &&
    exactDataEqual(materialized.installMarker, journal.finalInstallMarkerProjection)
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
async function missingEvidence(
  ports: BrowserResetPortsV2,
  journal: AllDataClearJournalV2,
): Promise<string | null> {
  const materialized: { runtime: unknown; setup: unknown; installMarker: unknown } =
    await ports.readMaterialized();
  if (!exactDataEqual(materialized.runtime, journal.runtimeProjection)) {
    return 'materialized-runtime-mismatch';
  }
  if (!exactDataEqual(materialized.setup, journal.setupProjection)) {
    return 'materialized-setup-mismatch';
  }
  // The marker is deliberately not checked here. Replay is what materializes it, so requiring it
  // before replaying would make the crash window between the projection write and the marker write
  // unrecoverable: nothing else in the system ever writes that marker. It is proved after the
  // replay instead, which is the only place it can be.
  if (resetProgressOf(journal).stablePasses !== 2) return 'reset-not-stable';
  return (await ports.deviceIdExists()) ? null : 'device-identity-missing';
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

async function resetJournal(): Promise<AllDataClearJournalV2> {
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
